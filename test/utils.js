'use strict';

module.exports = {
  expectError,
  timeoutPromise,
};

function timeoutPromise(timeout = 10) {
  return new Promise(resolve => setTimeout(resolve, timeout));
}


async function expectError(promise) {
  let error;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  if (!error) throw new Error('Expected an error');
  return error;
}

