// A tiny stand-in for Ollama so the end-to-end test indexes documents for real, offline.
// Embeddings are hashed bags of words: texts sharing words get similar vectors, so search is meaningful.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.FAKE_OLLAMA_PORT || 11999);
const DIM = 64;

function embed(text) {
  const v = new Array(DIM).fill(0);
  for (const word of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const h = createHash('sha256').update(word).digest();
    v[h[0] % DIM] += 1;
    v[h[1] % DIM] += 0.5;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/api/tags') return send(200, { models: [{ name: 'fake-embed' }] });
  if (req.method === 'POST' && req.url === '/api/embeddings') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => send(200, { embedding: embed(JSON.parse(raw).prompt) }));
    return;
  }
  send(404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`fake ollama on ${PORT}`));
