// FAKE users, buckets and files for the local proof, written straight to
// GoTrue and Storage (not through the gateway, whose log is Lifeboat's alone).
import { createHash } from 'node:crypto';

const key = process.env.SERVICE_KEY;
const headers = { authorization: `Bearer ${key}`, apikey: key };

async function call(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init.method} ${url}: ${res.status} ${await res.text()}`);
}
const json = (method, body) => ({ method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Deterministic fake bytes.
function bytes(seed, size) {
  const out = Buffer.alloc(size);
  for (let i = 0, block = 0; i < size; i += 32, block++) createHash('sha256').update(`${seed}:${block}`).digest().copy(out, i);
  return out;
}

const users = [['backup@lifeboat.test', process.env.BACKUP_USER_PASSWORD], ['fake.user1@example.test', 'fake-password-1'], ['fake.user2@example.test', 'fake-password-2']];
for (const [email, password] of users) await call('http://auth:9999/admin/users', json('POST', { email, password, email_confirm: true }));

for (const [id, isPublic] of [['avatars', true], ['documents', false], ['empty-bucket', false]]) {
  await call('http://storage:5000/bucket', json('POST', { id, name: id, public: isPublic }));
}

const objects = [
  ['avatars', 'fake-user-1.png', 2048],
  ['avatars', 'nested/dir/fake-user-2.png', 4096],
  ['documents', 'contracts/Fake Contract 1 (draft) & co.pdf', 150_000],
  ['documents', 'odd/name with spaces, + and = signs.txt', 333],
  ['documents', 'big/fake-archive.bin', 3 * 1024 * 1024],
  ['documents', 'folder/.emptyFolderPlaceholder', 0],
];
// More than one ListObjectsV2 page.
for (let i = 0; i < 1100; i++) objects.push(['avatars', `thumbs/fake-${String(i).padStart(4, '0')}.webp`, 64 + (i % 200)]);

for (const [bucket, name, size] of objects) {
  const path = name.split('/').map(encodeURIComponent).join('/');
  await call(`http://storage:5000/object/${bucket}/${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: bytes(name, size) });
}
console.log(`seeded ${users.length} users, 3 buckets, ${objects.length} objects`);
