// Copyright 2015-2016, Google, Inc.
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

// Activate Google Cloud Trace and Debug when in production
if (process.env.NODE_ENV === 'production') {
  require('@google/cloud-trace').start();
  require('@google/cloud-debug');
}

const request = require('request');
const waterfall = require('async').waterfall;
const express = require('express');
const config = require('./config');

const logging = require('./lib/logging');
const images = require('./lib/images');
const background = require('./lib/background');

const model = require(`./books/model-${config.get('DATA_BACKEND')}`);

// When running on Google App Engine Managed VMs, the worker needs
// to respond to HTTP requests and can optionally supply a health check.
// [START server]
const app = express();

app.use(logging.requestLogger);

app.get('/_ah/health', (req, res) => {
  res.status(200).send('ok');
});

// Keep count of how many books this worker has processed
let bookCount = 0;

app.get('/', (req, res) => {
  res.send(`This worker has processed ${bookCount} books.`);
});

app.use(logging.errorLogger);

if (module === require.main) {
  const server = app.listen(config.get('PORT'), () => {
    const port = server.address().port;
    console.log(`App listening on port ${port}`);
  });
}
// [END server]

function subscribe () {
  // Subscribe to Cloud Pub/Sub and receive messages to process books.
  // The subscription will continue to listen for messages until the process
  // is killed.
  // [START subscribe]
  const unsubscribeFn = background.subscribe((err, message) => {
    // Any errors received are considered fatal.
    if (err) {
      throw err;
    }
    if (message.action === 'processBook') {
      logging.info(`Received request to process book ${message.bookId}`);
      processBook(message.bookId);
    } else {
      logging.warn('Unknown request', message);
    }
  });
  // [END subscribe]
  return unsubscribeFn;
}

if (module === require.main) {
  subscribe();
}

// Processes a book by reading its existing data, attempting to find
// more information, and updating the database with the new information.
// [START process]
function processBook (bookId, callback) {
  if (!callback) {
    callback = logging.error;
  }
  waterfall([
    // Load the current data
    (cb) => {
      model.read(bookId, cb);
    },
    // Find the information from Google
    findBookInfo,
    // Save the updated data
    (updated, cb) => {
      model.update(updated.id, updated, false, cb);
    }
  ], (err) => {
    if (err) {
      logging.error('Error occurred', err);
      callback(err);
      return;
    }
    logging.info(`Updated book ${bookId}`);
    bookCount += 1;
    callback();
  });
}
// [END process]

// Tries to find additional information about a book and updates
// the book's data. Also uploads a cover image to Cloud Storage
// if available.
// [START find]
function findBookInfo (book, cb) {
  queryBooksApi(book.title, (err, r) => {
    if (err) {
      cb(err);
      return;
    }
    if (!r.items) {
      cb('Not found');
      return;
    }
    const top = r.items[0];

    book.title = top.volumeInfo.title;
    book.author = (top.volumeInfo.authors || []).join(', ');
    book.publishedDate = top.volumeInfo.publishedDate;
    book.description = book.description || top.volumeInfo.description;

    // If there is already an image for the book or if there's no
    // thumbnails, go ahead and return.
    if (book.imageUrl || !top.volumeInfo.imageLinks) {
      cb(null, book);
      return;
    }

    // Otherwise, try to fetch them and upload to cloud storage.
    const imageUrl =
      top.volumeInfo.imageLinks.thumbnail ||
      top.volumeInfo.imageLinks.smallThumbnail;
    const imageName = `${book.id}.jpg`;

    images.downloadAndUploadImage(
      imageUrl, imageName, (err, publicUrl) => {
        if (!err) {
          book.imageUrl = publicUrl;
        }
        cb(null, book);
      });
  });
}
// [END find]

// Calls out to the Google Books API to get additional
// information about a given book.
// [START query]
function queryBooksApi (query, cb) {
  request(
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}`,
    (err, resp, body) => {
      if (err || resp.statusCode !== 200) {
        cb(err || `Response returned ${resp.statusCode}`);
        return;
      }
      cb(null, JSON.parse(body));
    }
  );
}
// [END query]

exports.app = app;
exports.subscribe = subscribe;
exports.processBook = processBook;
exports.findBookInfo = findBookInfo;
exports.queryBooksApi = queryBooksApi;
