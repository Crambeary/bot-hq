// Isolated fixtures: never open the application database or use production credentials.
process.env.SESSION_SECRET = 'test-only-session-fixture';
process.env.DB_PATH = ':memory:';
await import('./prompt-snapshot.js');
await import('./vnc-clipboard.js');
