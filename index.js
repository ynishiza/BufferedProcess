'use strict';

const debug = require('debug')('mmdb:BufferedProcess');
const _ = require('lodash');

module.exports = {
  create,
  createWithMap,
  pipeBuffer,
};

function create(args) {
  return createBase({
    createBuffer() {
      const buffer = [];
      return {
        push(value) {
          buffer.push(value);
          return true;
        },
        getSize() {
          return buffer.length;
        },
        toArray() {
          return buffer.slice(0);
        },
        flush(size) {
          return buffer.splice(0, size);
        },
      };
    },
    ...args,
  });
}

function createWithMap({ getKey, ...args }) {
  if (!getKey) throw new Error('Missing getKey');
  return createBase({
    createBuffer() {
      const buffer = new Map();
      const that = {
        push(value) {
          const key = getKey(value);
          if (key == null) throw new Error('Bad key. Key cannot be null or undefined.');
          const isNewValue = !buffer.has(key);
          buffer.set(key, value);
          return isNewValue;
        },
        getSize() {
          return buffer.size;
        },
        toArray() {
          return [...buffer.values()];
        },
        flush(size) {
          return [...buffer.keys()]
            .slice(0, size)
            .map(k => {
              const value = buffer.get(k);
              buffer.delete(k);
              return value;
            });
        },
      };
      return that;
    },
    ...args,
  });
}

/*
 * Design note: sequential processing
 * Buffer should be flushed and processed sequentially.
 * This implies:
 * - queue: buffer processes should be enqueued and run one at a time.
 * - error handling: if an error occurs at any point, subsequent processes are
 *   dropped, as the sequence is broken at that point.
 */
function createBase({ maxSize = 10000, createBuffer, process, ...rest }) {
  const my = {
    id: _.uniqueId(),
    buffer: createBuffer(),
    flushCount: 0,
    total: 0,
    process,
    maxSize,

    // Processing related
    processQueue: [],
    currentProcess: null,
    error: null,
  };

  const that = {
    get isProcessing() { return !!my.currentProcess; },
    get currentProcess() { return my.currentProcess; },
    get buffer() { return my.buffer; },
    get maxSize() { return my.maxSize; },
    get flushCount() { return my.flushCount; },
    get total() { return my.total; },
    get error() { return my.error; },
    isFull,
    hasError,
    push,
    flush,
    waitForProcesses,
    pipe: pipe => pipeBuffer(that, pipe),
  };

  function _init() {
    assertNoOtherOptions(rest);
    if (!process) throw new Error('Missing process');
    if (!(maxSize > 0)) throw new Error('Invalid maxSize');
    _writeLog('init', `maxSize:${maxSize}`);
  }

  function _writeLog(topic, message) {
    debug(`${Date.now()} [id=${my.id}] ${topic} - ${message}`);
  }

  function isFull() {
    return my.buffer.getSize() >= my.maxSize;
  }

  // Design note: push() MUST be both sync and async.
  //
  // sync vs async: a subtle but critical point is that push() must be both sync and async in some
  // parts
  // - sync: must preserve the order in which data is added.
  //   i.e. adding to the buffer should be synchronous.
  // - async: must be able to prevent adding more data if a batch is getting processed.
  //   i.e. return from push() is asynchronous.
  //
  // We can still use an async function, however, since it behaves as expected.
  // i.e. an async function will still execute the code immediately until the first await is
  // encountered.
  async function push(data) {
    // case: stop accepting data if there was an error, since the buffer is broken now.
    if (hasError()) throw my.error;

    // increment count only if the buffer is bigger
    if (my.buffer.push(data)) {
      my.total += 1;
    }

    // Note: all of the above is synchronous upto the first awaits below.
    //
    // case: flush buffer if full
    if (isFull()) {
      _writeLog('push', 'flush full buffer');
      await _flushCurrentBufferAndSuppressError();
    }
    // case: wait before accepting more items.
    // If there are any processes, should wait before adding more items.
    if (my.currentProcess) {
      await waitForProcesses();
    }
  }

  function hasError() {
    return !!my.error;
  }


  async function waitForProcesses() {
    // note: why loop?
    // The value of my.currentProcess will keep changing as long as there is more data getting
    // flushed.
    // i.e. the value of my.currentProcess may change while it awaits for the old my.currentProcess.
    while (my.currentProcess) {
      const current = my.currentProcess;
      _writeLog('waitForProcesses', `start  queue length:${my.processQueue.length}`);
      // eslint-disable-next-line no-await-in-loop
      await current;
      _writeLog('waitForProcesses', `end end=${!my.currentProcess} changed=${my.currentProcess !== current}`);
    }
  }

  async function flush() {
    await waitForProcesses();
    await _flushCurrentBuffer();
  }

  async function _flushCurrentBufferAndSuppressError() {
    try {
      await _flushCurrentBuffer();
    // eslint-disable-next-line no-empty
    } catch (e) { }
  }

  // Design note: flushing the buffer MUST be synchronous.
  // In particular, the flush must be immediately be reflected in the state of the current
  // instance. This includes:
  // - clearing the current buffer.
  // - enqueuing a process for the current batch.
  // - starting the enqueued process, if none are running yet.
  //
  // Otherwise, the buffer and processes may not get handled correctly.
  // e.g.
  // - batches may get processes in the wrong order, if added to the queue asynchronously.
  // - the batch may exceed max size, if the buffer is not cleared synchronously, since the caller
  // may then keep adding more data until it is cleared.
  // - it may create a gap between when the buffer is cleared and the corresponding process is
  // started.
  //  i.e. a gap between the time of the flush and isProcessing evaluates to true.
  // This can cause the caller to keep reading more data from its source and overwhelm the memory.
  function _flushCurrentBuffer() {
    const output = new Promise((resolve, reject) => {
      // note: empty and non-empty buffers.
      // Even if the buffer is empty, add to process queue so we can wait until all the
      // processes are done.
      const data = my.buffer.flush(my.maxSize);
      my.flushCount += 1;
      const flushCount = my.flushCount;
      _writeLog('flush buffer', `data size:${data.length}`);

      my.processQueue.push(async() => {
        // case: an earlier process failed.
        // See design on sequential processing above.
        if (hasError()) {
          reject(my.error);
          return;
        }

        try {
          if (data.length > my.maxSize) {
            throw new Error(`Flush size too large. This should never happen. size=${data.length} maxSize=${my.maxSize}`);
          }
          if (data.length) await my.process.call(that, data, flushCount);
          resolve();
        } catch (e) {
          reject(e);
          throw e;
        }
      });

      _writeLog('flush buffer', `queue length:${my.processQueue.length}`);
      _tryTriggerNextProcess();
    });

    // Safety check: synchronousness check
    // These errors should never happen.
    // However, including safety assertions since synchronousness is critical here.
    // See design note above for details.
    if (my.buffer.getSize() !== 0) throw new Error('This should never happen');
    if (!my.currentProcess) throw new Error('This should never happen.');

    return output;
  }

  async function _tryTriggerNextProcess() {
    // case: processing already currently.
    // The next one will be started automatically after the previous one finishes.
    if (my.currentProcess) return;

    // case: nothing to flush.
    if (!my.processQueue.length) return;

    const next = my.processQueue.shift();
    _writeLog('process buffer', `start process.  remaining queue length:${my.processQueue.length}`);
    /*
     * IMPORTANT: at most one process per event loop
     *
     * Otherwise, if multiple processes are in the queue, we may process them consecutively and
     * block the event loop.
     * Don't block the event loop: https://nodejs.org/en/docs/guides/dont-block-the-event-loop/
    */
    my.currentProcess = _runInNextEventLoop((async() => {
      try {
        await next();
        _writeLog('process buffer', 'success');
      } catch (e) {
        _writeLog('process buffer', `error  ${e.stack}`);
        my.error = e;
      }
    }));
    await my.currentProcess;
    my.currentProcess = null;

    // start next
    _tryTriggerNextProcess();
  }

  _init();

  return that;
}

async function _runInNextEventLoop(callback) {
  return new Promise((resolve, reject) => {
    setTimeout(async() => {
      try {
        resolve(await callback());
      } catch (e) {
        reject(e);
      }
    }, 0);
  });
}

async function pipeBuffer(buffer, pipe) {
  async function each(item) {
    await buffer.push(item);
  }
  await pipe(each, buffer);
  await buffer.flush();
  return buffer;
}

function assertNoOtherOptions(args) {
  if (!!args && Object.keys(args).length > 0) {
    throw new Error(`Unknown options ${Object.keys(args).join(',')}`);
  }
}
