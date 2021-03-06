if (typeof Worker !== 'undefined') {
  // don't let inkjet.js use worker in this worker
  delete Worker;
}

self.importScripts('inkjet.js');

self.onmessage = (event) => {
  let {data, width, height, quality} = event.data;
  inkjet.encode(data, {width, height, quality}, (err, encoded) => {
    if (err) throw err;
    self.postMessage(encoded.data);
  });
};
