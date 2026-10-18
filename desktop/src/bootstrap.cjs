// Choose the app before either mode registers protocols or acquires its own lock.
if (process.argv.includes('--server-manager')) require('./server/main.js');
else require('./main.js');
