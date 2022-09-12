A stream processing util.
Process a stream in batches of items instead of one item at a time.
The util buffers the stream in a batch and flushes it for processing when the batch is full.

# Usage

```
const bufferedProc = createBufferedProcess({
  maxSize: 3,
  process: v => console.log(`value:${v}`),
});

// basic usage: pass each item manually with .push()
await bufferedProc.push(1);
await bufferedProc.push(2);
await bufferedProc.push(3);
// Flushes batch
// Console:
//   value:1
//   value:2
//   value:3
await bufferedProc.push(4);
await bufferedProc.push(5);
await bufferedProc.flush();
// Console:
//   value:4
//   value:5


// basic usage: process a stream with .pipe()
const data = [10,20,30,40,50,60,70];
const stream = each => data.forEach(each);
await bufferedProc.pipe(stream);
// Console:
//   value:10
//   value:20
//   value:30
//   value:40
//   value:50
//   value:60
//   value:70
```

# Development
```
$ npm i
$ npm run lint
$ npm run test
```
