module.exports = {
  apps: [{
    name: 'feishu-claude-bot',
    script: './dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      TESSDATA_PREFIX: './tessdata',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    max_memory_restart: '500M',
    autorestart: true,
    watch: false,
    windowsHide: true,
  }],
};
