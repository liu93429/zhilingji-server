// Vercel serverless 入口
const mod = require('../server');

module.exports = async (req, res) => {
  // 等待 app 就绪
  if (!mod._appReady) {
    await new Promise(resolve => {
      const check = () => {
        if (mod._appReady) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }
  return mod.app(req, res);
};
