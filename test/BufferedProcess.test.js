'use strict';

const _ = require('lodash');
const chai = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
const BufferedProcess = require('../index');
const { expectError, timeoutPromise } = require('./utils');

chai.use(sinonChai);

const { expect } = chai;
const identity = i => i;

function _createData(size, fn = identity) {
  return new Array(size).fill(1)
    .map((v, i) => fn(i));
}

describe('BufferedProcess', function() {
  describe('Ordered BufferedProcess', function() {
    baseFunctionalityTests({
      createBufferedProcess: args => BufferedProcess.create(args),
      generateData: _createData,
    });
  });

  describe('Map BufferedProcess', function() {
    baseFunctionalityTests({
      createBufferedProcess: args => BufferedProcess.createWithMap({
        getKey: () => _.uniqueId(),
        ...args,
      }),
      generateData: _createData,
    });

    it('does not count duplicate values', async function() {
      const process = sinon.spy();
      const maxSize = _.random(5, 20);
      const bufferedProc = BufferedProcess.createWithMap({
        getKey: v => v,
        process,
        maxSize,
      });

      // Add the same data multiple times
      const data = _createData(maxSize + 2);
      const initialSegment = data.slice(0, maxSize - 1);
      const rest = data.slice(maxSize - 1);
      initialSegment.forEach(bufferedProc.push);
      initialSegment.forEach(bufferedProc.push);
      initialSegment.forEach(bufferedProc.push);
      expect(bufferedProc.buffer.toArray()).to.be.lengthOf(maxSize - 1);
      expect(process).to.not.be.called;

      rest.forEach(bufferedProc.push);
      await bufferedProc.waitForProcesses();
      expect(bufferedProc.buffer.toArray()).to.be.lengthOf(2);
      expect(process).to.be.calledOnce;
    });

    it('uses the last value if multiple values with the same key are pushed', async function() {
      const process = sinon.spy();
      const bufferedProc = BufferedProcess.createWithMap({
        getKey: v => v.id,
        process,
        maxSize: 10,
      });

      bufferedProc.push({ id: 1, value: 10 });
      bufferedProc.push({ id: 1, value: 11 });
      expect(bufferedProc.buffer.toArray()).to.eql([
        { id: 1, value: 11 },
      ]);
      bufferedProc.push({ id: 1, value: 12 });
      expect(bufferedProc.buffer.toArray()).to.eql([
        { id: 1, value: 12 },
      ]);
      bufferedProc.push({ id: 2, value: 10 });
      bufferedProc.push({ id: 1, value: 13 });
      expect(bufferedProc.buffer.toArray()).to.eql([
        { id: 1, value: 13 },
        { id: 2, value: 10 },
      ]);
    });
  });
});

function baseFunctionalityTests({ createBufferedProcess, generateData }) {
  describe('push', function() {
    it('flushes the buffer correctly i.e. preserving order, even if data is added asynchronously', async function() {
      const result = [];
      const process = sinon.spy(async batch => {
        await timeoutPromise(10);
        batch.forEach(x => result.push(x));
      });
      const bufferedProc = createBufferedProcess({
        maxSize: 10,
        process,
      });

      const data = generateData(100);
      data.forEach(d => bufferedProc.push(d));
      await bufferedProc.flush();
      expect(bufferedProc.buffer.toArray()).to.be.lengthOf(0);
      expect(process).to.have.callCount(10);
      expect(result).to.eql(data);
    });

    it('if called with await, still adds the items in order but suspends returning until current processes are all done, if any', async function() {
      const result = [];
      const process = sinon.spy(async batch => {
        await timeoutPromise(1000);
        batch.forEach(d => result.push(d));
      });
      const bufferedProc = createBufferedProcess({
        maxSize: 10,
        process,
      });

      const data = generateData(20);
      const startTime = Date.now();
      data.forEach(bufferedProc.push);

      // check: should be processing batch now
      expect(bufferedProc.isProcessing).to.be.true;
      await Promise.all([
        bufferedProc.push(100),
        bufferedProc.push(101),
      ]);
      const endTime = Date.now();

      // test: push() should have resumed only after all previous process are done.
      expect(bufferedProc.isProcessing).to.be.false;
      expect(process).to.have.callCount(2);
      expect(endTime - startTime).to.be.at.least(2000);

      // test: push() should have added the items in order, even when called with await.
      await bufferedProc.flush();
      expect(result).to.eql([...data, 100, 101]);
    });

    it('stops accepting data after an error', async function() {
      const bufferedProc = createBufferedProcess({
        maxSize: 10,
        process: () => { throw new Error('Oops'); },
      });

      generateData(20).forEach(bufferedProc.push);
      let error;
      error = await expectError(bufferedProc.flush());
      expect(error.message).to.eql('Oops');

      // Throw error on subsequent push() calls.
      error = await expectError(bufferedProc.push(1));
      expect(error.message).to.eql('Oops');
    });
  });

  describe('process', function() {
    it('flushes and processes when the buffer is full', async function() {
      const maxSize = _.random(5, 20);
      const process = sinon.spy();
      const bufferedProc = createBufferedProcess({ maxSize, process });

      const data = generateData((maxSize * 3) + 5);
      data.forEach((x, i) => {
        bufferedProc.push(x);
        // test: buffer should be flushed when full.
        expect(bufferedProc.buffer.toArray()).to.be.lengthOf((i + 1) % maxSize);
      });

      await bufferedProc.flush();
      expect(process).to.have.callCount(4);
      expect(process.args).to.eql([
        [data.slice(0, maxSize), 1],
        [data.slice(maxSize, maxSize * 2), 2],
        [data.slice(maxSize * 2, maxSize * 3), 3],
        [data.slice(maxSize * 3), 4],
      ]);
    });

    it('begins the process synchronously as soon as the buffer is full', async function() {
      const process = sinon.spy(() => timeoutPromise(100));
      const bufferedProc = createBufferedProcess({
        maxSize: 10,
        process,
      });

      expect(bufferedProc.isProcessing).to.be.false;
      generateData(11).forEach(bufferedProc.push);

      // Process should have started already.
      expect(bufferedProc.isProcessing).to.be.true;
    });

    it('processes the buffer sequentially in the order that it is flushed', async function() {
      const interval = 100;
      const startTimes = [];
      const endTimes = [];
      const process = sinon.spy(async() => {
        startTimes.push(Date.now());
        await timeoutPromise(interval + 10);
        endTimes.push(Date.now());
      });
      const bufferedProc = createBufferedProcess({
        maxSize: 10,
        process,
      });

      generateData(40).forEach(bufferedProc.push);

      await bufferedProc.flush();
      expect(process).to.have.callCount(4);
      expect(startTimes[1]).to.be.at.least(endTimes[0]);
      expect(startTimes[2]).to.be.at.least(endTimes[1]);
      expect(startTimes[3]).to.be.at.least(endTimes[2]);
    });

    it('processes the buffer in batches of at most maxSize at a time if the total buffered data is much larger', async function() {
      const maxSize = _.random(5, 20);
      // note: include a delay in the process so all the data is added while a batch is still
      // getting processed
      const processDelay = 1000;
      const startTime = Date.now();
      const process = sinon.spy(() => timeoutPromise(processDelay));
      const bufferedProc = createBufferedProcess({ maxSize, process });

      const data = generateData((maxSize * 3) + 5);
      data.forEach((x, i) => {
        bufferedProc.push(x);
        expect(bufferedProc.buffer.toArray()).to.be.lengthOf((i + 1) % maxSize);
      });

      await bufferedProc.flush();
      // check: verify delay per process
      expect(Date.now() - startTime).to.be.above(processDelay * 4);
      // test: each batch is at most maxSize.
      expect(process).to.have.callCount(4);
      expect(process.args).to.eql([
        [data.slice(0, maxSize), 1],
        [data.slice(maxSize, maxSize * 2), 2],
        [data.slice(maxSize * 2, maxSize * 3), 3],
        [data.slice(maxSize * 3), 4],
      ]);
    });

    it('flushes the current buffer on flush()', async function() {
      const process = sinon.spy(() => timeoutPromise(100));
      const bufferedProc = createBufferedProcess({
        maxSize: 10,
        process,
      });

      // case: flush() on non-empty buffer.
      // Should flush the current buffer and wait.
      generateData(35).forEach(bufferedProc.push);
      expect(bufferedProc.buffer.toArray()).to.be.lengthOf(5);
      await bufferedProc.flush();
      expect(bufferedProc.buffer.toArray()).to.be.lengthOf(0);
      expect(process).to.have.callCount(4);

      // case: flush() on empty buffer.
      // Wait until all earlier flushes are complete.
      generateData(20).forEach(bufferedProc.push);
      expect(bufferedProc.buffer.toArray()).to.be.lengthOf(0);
      await bufferedProc.flush();
      expect(bufferedProc.buffer.toArray()).to.be.lengthOf(0);
      expect(process).to.have.callCount(6);
    });

    it('should not call the process when flushed with an empty buffer', async function() {
      const process = sinon.spy(() => timeoutPromise(100));
      const bufferedProc = createBufferedProcess({
        maxSize: 10,
        process,
      });

      // Flush when there is no data to process.
      // This shouldn't call the process
      await bufferedProc.flush();
      await bufferedProc.flush();
      expect(process).to.have.callCount(0);

      // Add data
      bufferedProc.push(1);
      await bufferedProc.flush();
      expect(process).to.have.callCount(1);

      // Flush when the buffer is empty again.
      await bufferedProc.flush();
      await bufferedProc.flush();
      expect(process).to.have.callCount(1);
    });

    it('waits for processes, if any, on waitForProcesses()', async function() {
      const process = sinon.spy(() => timeoutPromise(100));
      const bufferedProc = createBufferedProcess({
        maxSize: 10,
        process,
      });

      // No process yet
      expect(bufferedProc.isProcessing).to.be.false;
      await bufferedProc.waitForProcesses();
      expect(bufferedProc.isProcessing).to.be.false;

      expect(bufferedProc.isProcessing).to.be.false;
      generateData(3).forEach(bufferedProc.push);
      expect(bufferedProc.isProcessing).to.be.false;
      await bufferedProc.waitForProcesses();
      expect(bufferedProc.isProcessing).to.be.false;

      generateData(6).forEach(bufferedProc.push);
      expect(bufferedProc.isProcessing).to.be.false;
      await bufferedProc.waitForProcesses();
      expect(bufferedProc.isProcessing).to.be.false;

      // Buffer full. Process started.
      generateData(3).forEach(bufferedProc.push);
      expect(bufferedProc.isProcessing).to.be.true;
      await bufferedProc.waitForProcesses();
      expect(bufferedProc.isProcessing).to.be.false;
      // Process done
      expect(process).to.have.callCount(1);
      expect(bufferedProc.buffer.toArray()).to.be.lengthOf(2);

      // No process again
      expect(bufferedProc.isProcessing).to.be.false;
      await bufferedProc.waitForProcesses();
      expect(bufferedProc.isProcessing).to.be.false;
    });

    it('waits for both current and enqueued processes to finish on waitForProcesses()', async function() {
      const process = sinon.spy(() => timeoutPromise(100));
      const bufferedProc = createBufferedProcess({
        maxSize: 10,
        process,
      });

      generateData(35).forEach(bufferedProc.push);

      expect(bufferedProc.isProcessing).to.be.true;
      await bufferedProc.waitForProcesses();
      expect(bufferedProc.isProcessing).to.be.false;

      // 3 batches processed
      expect(process).to.have.callCount(3);
      // remaining
      expect(bufferedProc.buffer.toArray()).to.be.lengthOf(5);
    });

    it('raises an error if a process fails at any point', async function() {
      /* eslint-disable newline-per-chained-call */
      const process = sinon.stub()
        .onCall(0).returns(null)
        .onCall(1).throws(new Error('Oops'))

        // Should never reach these calls
        .onCall(2).returns(null)
        .onCall(3).returns(null);
      /* eslint-enable newline-per-chained-call */

      const bufferedProc = createBufferedProcess({
        maxSize: 5,
        process,
      });

      generateData(20).forEach(bufferedProc.push);

      // Should throw first error encountered.
      let error = await expectError(bufferedProc.flush());
      expect(error.message).to.eql('Oops');
      expect(process).to.have.callCount(2);

      // Should rethrow same error.
      error = await expectError(bufferedProc.flush());
      expect(error.message).to.eql('Oops');
    });
  });

  it('can pipe from a stream', async function() {
    const process = sinon.spy();
    const bufferedProc = createBufferedProcess({
      maxSize: 10,
      process,
    });
    const data = generateData(100);
    const stream = each => data.forEach(each);
    await bufferedProc.pipe(stream);
    expect(process).to.have.callCount(10);
  });
}

