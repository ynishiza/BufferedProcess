'use strict';

module.exports = {
  plugin: ['plugins/markdown'],
  source: {
    include: ['./index.js'],
  },
  opts: {
    encoding: 'utf8',
    recurse: true,
  },
};
