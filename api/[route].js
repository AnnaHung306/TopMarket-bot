import worker from '../worker/index.js';

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/report') {
      url.pathname = '/';
      return worker.fetch(new Request(url, request));
    }
    return worker.fetch(request);
  },
};
