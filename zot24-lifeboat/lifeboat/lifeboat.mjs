#!/usr/bin/env node
const usage = `usage:
  lifeboat backup
  lifeboat restore <snapshot|latest> <target-postgres-url> <folder> [--from r2]
  lifeboat drill
  lifeboat snapshots [--from r2]
  lifeboat serve`;

const args = process.argv.slice(2);
const fromIndex = args.indexOf('--from');
const from = fromIndex === -1 ? 'local' : args.splice(fromIndex, 2)[1];
const [command, ...rest] = args;

if (command === 'serve') {
  await import('./server.mjs');
} else {
  const lib = await import('./lib.mjs');
  const commands = {
    backup: () => lib.backup(),
    drill: () => lib.drill(),
    snapshots: () => lib.snapshots(from),
    restore: () => (rest.length === 3 ? lib.restore(rest[0], rest[1], rest[2], from) : Promise.reject(new Error(usage))),
  };
  if (!commands[command] || !['local', 'r2'].includes(from)) {
    console.error(usage);
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(await commands[command](), null, 2));
  } catch (e) {
    console.error(`lifeboat ${command} failed: ${e.message}`);
    process.exit(1);
  }
}
