const sleep = time => new Promise(resolve => setTimeout(resolve, time || 1e3))
const { ProcessManager } = require(`@wll8/process-manager`);
const cp = new ProcessManager({
  bin: `cmd.exe`,
  arg: [
    `/c`,
    `cd doc && npm run docs:dev`,
  ],
});
cp.on(`stdout`, (data = ``) => {
  const [, url] = data.match(/Network:\s+(.*)\n/) || []
  url && runExe(url)
})
cp.on(`close`, () => {
  console.log(`close`);
});

async function runExe(url) {
  if(global.runing) {
    return undefined
  }
  global.runing = true
  const fs = require(`fs`)
  const text = fs.readFileSync(`./package.json`, `utf8`)
  const textJson = JSON.parse(text)
  textJson.page = url
  fs.writeFileSync(`./package.json`, JSON.stringify(textJson, null, 2))
  const cp = new ProcessManager({
    bin: `main.exe`,
    autoReStart: false,
  });
  cp.on(`close`, () => {
    process.exit()
  });
  await sleep()
  fs.writeFileSync(`./package.json`, text)
}
