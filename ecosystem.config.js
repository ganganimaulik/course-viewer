module.exports = {
  apps: [
    {
      name: 'course-viewer',
      script: 'server.js',
      // Run as a single instance (fork mode) to avoid conflicts writing to the local db.json file
      instances: 1,
      exec_mode: 'fork',
      // We set watch to false by default. If you want automatic restarts on code change during development,
      // nodemon or setting this to true is recommended.
      watch: false,
      // Ignore database and static assets to prevent PM2 restart loops if watch is set to true
      ignore_watch: [
        'node_modules',
        'db.json',
        'public',
        '.git',
        '*.log'
      ],
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3005
      }
    }
  ]
};
