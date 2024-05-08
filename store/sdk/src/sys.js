import mitt from 'mitt'
import {
  deepProxy,
  removeLeft,
  isUTF8MultiByteContinuation,
  isUTF8MultiByteStart,
  getUuid,
  sliceStringByBytes,
  isType,
  removeEmpty,
 } from '@/util.js'
import Neutralino from '@/api/neutralino/index.js'
let lib = {
  encoder: undefined,
  decoder: undefined,
}
let ws = undefined

class CodeObj {
  constructor(arg, { id, runType = `thread` }) {
    let [code, ...codeArg] = arg
    code = removeLeft(code).trim()
    function simpleTemplate(template, data) {
      return template.replace(/#\{(\w+)\}/g, (match, key) => data[key] || ``)
    }
    // 注：线程中的代码运行完成后，线程会自动关闭的
    const template = removeLeft({
      thread: `
        var arg = {...}
        thread.create(function(...){
          import lib;
          var tid = thread.getId()
          var runid = "#{id}"
          var arg = {...}
          var res = null
          var err = false
          try {
            var code = /**
            var tid = thread.getId()
            var runid = "#{id}"
            var arg = {...}
            #{code}
            **/
            fn, err = loadcode(code)
            res = {fn(table.unpack(arg))}
          }
          catch (e) {
            err = err || tostring(e);
          }
          var data = {type: err ? "err" : "return", err: err, res: res, tid: tid}
          thread.command.publish(runid, data)
        }, table.unpack(arg))
      `,
      main: `
        var tid = thread.getId()
        var runid = "#{id}"
        var arg = {...}
        var res = null
        var err = false
        try {
          var code = /**
          var tid = thread.getId()
          var runid = "#{id}"
          var arg = {...}
          #{code}
          **/
          fn, err = loadcode(code)
          res = {fn(table.unpack(arg))}
        }
        catch (e) {
          err = err || tostring(e);
        }
        var data = {type: err ? "err" : "return", err: err, res: res, tid: tid}
        global.G.rpcServer.publish(runid, data)
      `,
      raw: code,
    }[runType]).trim()
    const codeWrap = simpleTemplate(template, {
      id,
      code,
    })
    this.id = id
    this.codeClean = code
    this.codeWrap = codeWrap
    this.codeArg = codeArg
    this.newArg = [codeWrap, ...codeArg]
  }
}

class Base {
  constructor() {
    const createProxy = (cfg = {}) => {
      return deepProxy({cb: (list) => {
        return new Promise(async (res) => {
          function strFix (str) {
            return /^\d+$/.test(str) ? `[${str}]` : `.${str}`
          }
          let argList = []
          let argListIndex = -1
          let hasReference = false // 如果参数中没有任何引用类型，则直接移除参数，因为参数已被直接转换成 code
          let code = list.reduce((acc, {type, key, arg = []}, argIndex) => {
            if(type === `get`) {
              acc = acc + strFix(key)
            }
            if(type === `apply`) {
              argListIndex = argListIndex + 1
              argList[argListIndex] = arg
              acc = acc + `${strFix(key)}(${arg.map((item, itemIndex) => {
                const type = isType(item)
                const isReference = [`object`, `array`].includes(type)
                hasReference = hasReference || isReference
                const argId = [argListIndex, itemIndex].join(`,`) // 参数 id
                // 如果是引用类型参数，则使用引用方式传递，否则使用字面量方式
                if(type === `function`) {
                  return removeLeft(`function(...){
                    var arg = {...}
                    thread.command.publish(runid, {type: "cb-arg", res: arg, argId: "${argId}", tid: tid});
                  }`)
                } else {
                  return isReference ? `arg[${argListIndex + 1}][${itemIndex + 1}]` : JSON.stringify(item)
                }
              }).join(`, `)})`
            }
            return acc
          }, ``).slice(1)
          code = removeLeft(`
            return ${code}
          `)
          cfg._argList = argList
          let runRes = await ws.call(`run`, [code, ...(hasReference ? argList : [])], cfg)
          res(runRes)
        })
      }})
    }
    this.native = createProxy()
    this.nativeMain = createProxy({runType: `main`})
  }
  get api() {
    return {
      neutralino: async () => {
        const res = await new Neutralino(this)
        return res
      },
    }
  }
}

class Tray extends Base {
  constructor(...arg) {
    super()
    this.key = `tray`
    return new Promise(async (resolve) => {
      const hwnd = await ws.call(`${this.key}.create`, arg)
      this.hwnd = hwnd
      resolve(this)
    })
  }
  on(key, fn) {
    ws.call(`${this.key}.on`, [this.hwnd, key])
    return ws.on(`${this.hwnd}.${key}`, fn)
  }
  off(key) {
    ws.call(`${this.key}.off`, [this.hwnd, key])
  }
}
class View extends Base {
  constructor(...arg) {
    super()
    this.key = `view`
    return new Promise(async (resolve) => {
      const hwnd = await ws.call(`${this.key}.create`, arg)
      this.hwnd = hwnd
      resolve(this)
    })
  }
}
class Msg extends Base {
  constructor(...arg) {
    super()
    return this
  }
  on(key, fn) {
    return ws.on(key, (arg) => {
      fn(...arg)
    })
  }
  off(key) {
    return ws.off(key)
  }
  /**
   * hack
   * 以分步传输的形式避免传参过大的错误
   * https://github.com/wll8/sys-shim/issues/3
   */
  emit(...arg) {
    return ws.call(`run`, [
      `
      thread.command.publish(...);
      `,
      ...arg,
    ])
  }
}
class Sys extends Base {
  constructor(cfg) {
    cfg.log = cfg.log === true ? (log) => {
      log.startTime && console.group(log.id)
      let [code = ``, ...codeArg] = Array.from(log.reqRaw)
      const [err, ...resArg] =  Array.from(log.resRaw)
      if(log.startTime) {
        code = code.trim()
        console.log(code)
        removeEmpty(codeArg) && console.table(codeArg)
      }
      if(log.endTime) {
        err ? console.error(err) : console.log(...resArg)
        console.groupEnd(log.id)
      }
    } : cfg.log
    lib = cfg.lib
    ws = cfg.ws
    super()
    this.ws = cfg.ws
    this.log = mitt()
    cfg.log && this.log.on(`log`, cfg.log)
    const getBaseLog = () => ({
      id: ``, // 当前运行的 id
      action: ``, // 当前动作
      startTime: ``, // 当前 id 开始时间
      endTime: ``, // 当前 id 结束时间
      reqRaw: [], // 待发送给服务器的，当 action 为 run 时，第一项为代码，其他项为参数
      resRaw: [], // 接收到的服务器响应，第一项为是否错误，其他项为返回值
    })
    /**
     * hack
     * 以分步传输的形式避免传参过大的错误
     * https://github.com/wll8/sys-shim/issues/3
     */
    const call = ws.call
    ws.call = async (action, arg = [], runOpt = {}) => {
      runOpt = {
        runType: `thread`,
        ...runOpt,
      }
      const id = `code-${getUuid()}`
      const codeObj = new CodeObj(arg, { id, ...runOpt })
      let log = {
        ...getBaseLog(),
        id,
        action,
        startTime: Date.now(),
        reqRaw: [codeObj.codeClean, ...codeObj.codeArg],
      }
      this.log.emit(`log`, log)
      return new Promise(async (resolve) => {
        call.bind(ws)(action, codeObj.newArg)
        let log = {
          ...getBaseLog(),
          id,
          action,
          endTime: Date.now(),
          resRaw: [],
        }
        // todo 线程退出后应取消监听
        this.msg.on(id, (data) => {
          let {tid, type, err, res = []} = data
          if(type === `cb-arg`) {
            const fn = data.argId.split(`,`).reduce((acc, cur) => acc[cur], runOpt._argList)
            fn(...res)
          }
          res = Array.from(res)
          const resRaw = [err, ...res]
          log.resRaw = resRaw
          if([`return`, `err`].includes(type)) {
            this.log.emit(`log`, log)
            resolve(resRaw)
            this.msg.off(id)
          }
        })
      })
    }
    return new Promise(async (resolve, reject) => {
      if (typeof Sys.instance === `object`) {
        return Sys.instance
      }
      Sys.instance = this
      ws.on(`open`, async () => {
        this.Tray = Tray
        this.View = View
        this.Msg = Msg
        this.msg = await new Msg()
        this.msg.on(`native:log`, console.debug)
        resolve(this)
      })
    })
  }
}

export default Sys
