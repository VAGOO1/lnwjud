// Owned fixture only: no files, network, subprocesses, shop data, or business command.
process.stdout.write('READY\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (text) => { if (text.trim() === 'finish') process.exit(23); });
process.stdin.on('end', () => process.exit(23));
process.stdin.resume();
