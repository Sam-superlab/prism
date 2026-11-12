// The Windows parent requests the same graceful shutdown used by the Mac services.
process.on('message', (message) => {
  if (message?.type === 'shutdown') process.emit('SIGTERM', 'SIGTERM');
});
process.on('disconnect', () => process.emit('SIGTERM', 'SIGTERM'));
await import(process.argv[2]);
