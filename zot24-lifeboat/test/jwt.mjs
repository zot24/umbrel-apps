// node jwt.mjs <role> <secret>: a Supabase-style API key for the fake project.
import { createHmac } from 'node:crypto';

const [role, secret] = process.argv.slice(2);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', ref: 'lifeboatfake', role, iat: 1767225600, exp: 2082758400 })}`;
console.log(`${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`);
