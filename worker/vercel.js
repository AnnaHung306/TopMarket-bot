import worker from './index.js';

export default {
  fetch(request) {
    if (!process.env.ALCHEMY_API_KEY?.trim()) {
      return Response.json({ error: 'Alchemy Base RPC is not configured' }, { status: 503 });
    }
    return worker.fetch(request);
  },
};
