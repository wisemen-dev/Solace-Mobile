(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // node_modules/@capacitor/core/dist/index.js
  var ExceptionCode, CapacitorException, getPlatformId, createCapacitor, initCapacitorGlobal, Capacitor, registerPlugin, WebPlugin, encode, decode, CapacitorCookiesPluginWeb, CapacitorCookies, readBlobAsBase64, normalizeHttpHeaders, buildUrlParams, buildRequestInit, CapacitorHttpPluginWeb, CapacitorHttp;
  var init_dist = __esm({
    "node_modules/@capacitor/core/dist/index.js"() {
      (function(ExceptionCode2) {
        ExceptionCode2["Unimplemented"] = "UNIMPLEMENTED";
        ExceptionCode2["Unavailable"] = "UNAVAILABLE";
      })(ExceptionCode || (ExceptionCode = {}));
      CapacitorException = class extends Error {
        constructor(message, code, data) {
          super(message);
          this.message = message;
          this.code = code;
          this.data = data;
        }
      };
      getPlatformId = (win) => {
        var _a, _b;
        if (win === null || win === void 0 ? void 0 : win.androidBridge) {
          return "android";
        } else if ((_b = (_a = win === null || win === void 0 ? void 0 : win.webkit) === null || _a === void 0 ? void 0 : _a.messageHandlers) === null || _b === void 0 ? void 0 : _b.bridge) {
          return "ios";
        } else {
          return "web";
        }
      };
      createCapacitor = (win) => {
        const capCustomPlatform = win.CapacitorCustomPlatform || null;
        const cap = win.Capacitor || {};
        const Plugins = cap.Plugins = cap.Plugins || {};
        const getPlatform = () => {
          return capCustomPlatform !== null ? capCustomPlatform.name : getPlatformId(win);
        };
        const isNativePlatform = () => getPlatform() !== "web";
        const isPluginAvailable = (pluginName) => {
          const plugin = registeredPlugins.get(pluginName);
          if (plugin === null || plugin === void 0 ? void 0 : plugin.platforms.has(getPlatform())) {
            return true;
          }
          if (getPluginHeader(pluginName)) {
            return true;
          }
          return false;
        };
        const getPluginHeader = (pluginName) => {
          var _a;
          return (_a = cap.PluginHeaders) === null || _a === void 0 ? void 0 : _a.find((h) => h.name === pluginName);
        };
        const handleError = (err) => win.console.error(err);
        const registeredPlugins = /* @__PURE__ */ new Map();
        const registerPlugin2 = (pluginName, jsImplementations = {}) => {
          const registeredPlugin = registeredPlugins.get(pluginName);
          if (registeredPlugin) {
            console.warn(`Capacitor plugin "${pluginName}" already registered. Cannot register plugins twice.`);
            return registeredPlugin.proxy;
          }
          const platform = getPlatform();
          const pluginHeader = getPluginHeader(pluginName);
          let jsImplementation;
          const loadPluginImplementation = async () => {
            if (!jsImplementation && platform in jsImplementations) {
              jsImplementation = typeof jsImplementations[platform] === "function" ? jsImplementation = await jsImplementations[platform]() : jsImplementation = jsImplementations[platform];
            } else if (capCustomPlatform !== null && !jsImplementation && "web" in jsImplementations) {
              jsImplementation = typeof jsImplementations["web"] === "function" ? jsImplementation = await jsImplementations["web"]() : jsImplementation = jsImplementations["web"];
            }
            return jsImplementation;
          };
          const createPluginMethod = (impl, prop) => {
            var _a, _b;
            if (pluginHeader) {
              const methodHeader = pluginHeader === null || pluginHeader === void 0 ? void 0 : pluginHeader.methods.find((m) => prop === m.name);
              if (methodHeader) {
                if (methodHeader.rtype === "promise") {
                  return (options) => cap.nativePromise(pluginName, prop.toString(), options);
                } else {
                  return (options, callback) => cap.nativeCallback(pluginName, prop.toString(), options, callback);
                }
              } else if (impl) {
                return (_a = impl[prop]) === null || _a === void 0 ? void 0 : _a.bind(impl);
              }
            } else if (impl) {
              return (_b = impl[prop]) === null || _b === void 0 ? void 0 : _b.bind(impl);
            } else {
              throw new CapacitorException(`"${pluginName}" plugin is not implemented on ${platform}`, ExceptionCode.Unimplemented);
            }
          };
          const createPluginMethodWrapper = (prop) => {
            let remove;
            const wrapper = (...args) => {
              const p = loadPluginImplementation().then((impl) => {
                const fn = createPluginMethod(impl, prop);
                if (fn) {
                  const p2 = fn(...args);
                  remove = p2 === null || p2 === void 0 ? void 0 : p2.remove;
                  return p2;
                } else {
                  throw new CapacitorException(`"${pluginName}.${prop}()" is not implemented on ${platform}`, ExceptionCode.Unimplemented);
                }
              });
              if (prop === "addListener") {
                p.remove = async () => remove();
              }
              return p;
            };
            wrapper.toString = () => `${prop.toString()}() { [capacitor code] }`;
            Object.defineProperty(wrapper, "name", {
              value: prop,
              writable: false,
              configurable: false
            });
            return wrapper;
          };
          const addListener = createPluginMethodWrapper("addListener");
          const removeListener = createPluginMethodWrapper("removeListener");
          const addListenerNative = (eventName, callback) => {
            const call = addListener({ eventName }, callback);
            const remove = async () => {
              const callbackId = await call;
              removeListener({
                eventName,
                callbackId
              }, callback);
            };
            const p = new Promise((resolve2) => call.then(() => resolve2({ remove })));
            p.remove = async () => {
              console.warn(`Using addListener() without 'await' is deprecated.`);
              await remove();
            };
            return p;
          };
          const proxy = new Proxy({}, {
            get(_, prop) {
              switch (prop) {
                // https://github.com/facebook/react/issues/20030
                case "$$typeof":
                  return void 0;
                case "toJSON":
                  return () => ({});
                case "addListener":
                  return pluginHeader ? addListenerNative : addListener;
                case "removeListener":
                  return removeListener;
                default:
                  return createPluginMethodWrapper(prop);
              }
            }
          });
          Plugins[pluginName] = proxy;
          registeredPlugins.set(pluginName, {
            name: pluginName,
            proxy,
            platforms: /* @__PURE__ */ new Set([...Object.keys(jsImplementations), ...pluginHeader ? [platform] : []])
          });
          return proxy;
        };
        if (!cap.convertFileSrc) {
          cap.convertFileSrc = (filePath) => filePath;
        }
        cap.getPlatform = getPlatform;
        cap.handleError = handleError;
        cap.isNativePlatform = isNativePlatform;
        cap.isPluginAvailable = isPluginAvailable;
        cap.registerPlugin = registerPlugin2;
        cap.Exception = CapacitorException;
        cap.DEBUG = !!cap.DEBUG;
        cap.isLoggingEnabled = !!cap.isLoggingEnabled;
        return cap;
      };
      initCapacitorGlobal = (win) => win.Capacitor = createCapacitor(win);
      Capacitor = /* @__PURE__ */ initCapacitorGlobal(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {});
      registerPlugin = Capacitor.registerPlugin;
      WebPlugin = class {
        constructor() {
          this.listeners = {};
          this.retainedEventArguments = {};
          this.windowListeners = {};
        }
        addListener(eventName, listenerFunc) {
          let firstListener = false;
          const listeners = this.listeners[eventName];
          if (!listeners) {
            this.listeners[eventName] = [];
            firstListener = true;
          }
          this.listeners[eventName].push(listenerFunc);
          const windowListener = this.windowListeners[eventName];
          if (windowListener && !windowListener.registered) {
            this.addWindowListener(windowListener);
          }
          if (firstListener) {
            this.sendRetainedArgumentsForEvent(eventName);
          }
          const remove = async () => this.removeListener(eventName, listenerFunc);
          const p = Promise.resolve({ remove });
          return p;
        }
        async removeAllListeners() {
          this.listeners = {};
          for (const listener in this.windowListeners) {
            this.removeWindowListener(this.windowListeners[listener]);
          }
          this.windowListeners = {};
        }
        notifyListeners(eventName, data, retainUntilConsumed) {
          const listeners = this.listeners[eventName];
          if (!listeners) {
            if (retainUntilConsumed) {
              let args = this.retainedEventArguments[eventName];
              if (!args) {
                args = [];
              }
              args.push(data);
              this.retainedEventArguments[eventName] = args;
            }
            return;
          }
          listeners.forEach((listener) => listener(data));
        }
        hasListeners(eventName) {
          var _a;
          return !!((_a = this.listeners[eventName]) === null || _a === void 0 ? void 0 : _a.length);
        }
        registerWindowListener(windowEventName, pluginEventName) {
          this.windowListeners[pluginEventName] = {
            registered: false,
            windowEventName,
            pluginEventName,
            handler: (event) => {
              this.notifyListeners(pluginEventName, event);
            }
          };
        }
        unimplemented(msg = "not implemented") {
          return new Capacitor.Exception(msg, ExceptionCode.Unimplemented);
        }
        unavailable(msg = "not available") {
          return new Capacitor.Exception(msg, ExceptionCode.Unavailable);
        }
        async removeListener(eventName, listenerFunc) {
          const listeners = this.listeners[eventName];
          if (!listeners) {
            return;
          }
          const index = listeners.indexOf(listenerFunc);
          this.listeners[eventName].splice(index, 1);
          if (!this.listeners[eventName].length) {
            this.removeWindowListener(this.windowListeners[eventName]);
          }
        }
        addWindowListener(handle) {
          window.addEventListener(handle.windowEventName, handle.handler);
          handle.registered = true;
        }
        removeWindowListener(handle) {
          if (!handle) {
            return;
          }
          window.removeEventListener(handle.windowEventName, handle.handler);
          handle.registered = false;
        }
        sendRetainedArgumentsForEvent(eventName) {
          const args = this.retainedEventArguments[eventName];
          if (!args) {
            return;
          }
          delete this.retainedEventArguments[eventName];
          args.forEach((arg) => {
            this.notifyListeners(eventName, arg);
          });
        }
      };
      encode = (str) => encodeURIComponent(str).replace(/%(2[346B]|5E|60|7C)/g, decodeURIComponent).replace(/[()]/g, escape);
      decode = (str) => str.replace(/(%[\dA-F]{2})+/gi, decodeURIComponent);
      CapacitorCookiesPluginWeb = class extends WebPlugin {
        async getCookies() {
          const cookies = document.cookie;
          const cookieMap = {};
          cookies.split(";").forEach((cookie) => {
            if (cookie.length <= 0)
              return;
            let [key, value] = cookie.replace(/=/, "CAP_COOKIE").split("CAP_COOKIE");
            key = decode(key).trim();
            value = decode(value).trim();
            cookieMap[key] = value;
          });
          return cookieMap;
        }
        async setCookie(options) {
          try {
            const encodedKey = encode(options.key);
            const encodedValue = encode(options.value);
            const expires = options.expires ? `; expires=${options.expires.replace("expires=", "")}` : "";
            const path = (options.path || "/").replace("path=", "");
            const domain = options.url != null && options.url.length > 0 ? `domain=${options.url}` : "";
            document.cookie = `${encodedKey}=${encodedValue || ""}${expires}; path=${path}; ${domain};`;
          } catch (error) {
            return Promise.reject(error);
          }
        }
        async deleteCookie(options) {
          try {
            document.cookie = `${options.key}=; Max-Age=0`;
          } catch (error) {
            return Promise.reject(error);
          }
        }
        async clearCookies() {
          try {
            const cookies = document.cookie.split(";") || [];
            for (const cookie of cookies) {
              document.cookie = cookie.replace(/^ +/, "").replace(/=.*/, `=;expires=${(/* @__PURE__ */ new Date()).toUTCString()};path=/`);
            }
          } catch (error) {
            return Promise.reject(error);
          }
        }
        async clearAllCookies() {
          try {
            await this.clearCookies();
          } catch (error) {
            return Promise.reject(error);
          }
        }
      };
      CapacitorCookies = registerPlugin("CapacitorCookies", {
        web: () => new CapacitorCookiesPluginWeb()
      });
      readBlobAsBase64 = async (blob) => new Promise((resolve2, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const base64String = reader.result;
          resolve2(base64String.indexOf(",") >= 0 ? base64String.split(",")[1] : base64String);
        };
        reader.onerror = (error) => reject(error);
        reader.readAsDataURL(blob);
      });
      normalizeHttpHeaders = (headers = {}) => {
        const originalKeys = Object.keys(headers);
        const loweredKeys = Object.keys(headers).map((k) => k.toLocaleLowerCase());
        const normalized = loweredKeys.reduce((acc, key, index) => {
          acc[key] = headers[originalKeys[index]];
          return acc;
        }, {});
        return normalized;
      };
      buildUrlParams = (params, shouldEncode = true) => {
        if (!params)
          return null;
        const output = Object.entries(params).reduce((accumulator, entry) => {
          const [key, value] = entry;
          let encodedValue;
          let item;
          if (Array.isArray(value)) {
            item = "";
            value.forEach((str) => {
              encodedValue = shouldEncode ? encodeURIComponent(str) : str;
              item += `${key}=${encodedValue}&`;
            });
            item.slice(0, -1);
          } else {
            encodedValue = shouldEncode ? encodeURIComponent(value) : value;
            item = `${key}=${encodedValue}`;
          }
          return `${accumulator}&${item}`;
        }, "");
        return output.substr(1);
      };
      buildRequestInit = (options, extra = {}) => {
        const output = Object.assign({ method: options.method || "GET", headers: options.headers }, extra);
        const headers = normalizeHttpHeaders(options.headers);
        const type = headers["content-type"] || "";
        if (typeof options.data === "string") {
          output.body = options.data;
        } else if (type.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(options.data || {})) {
            params.set(key, value);
          }
          output.body = params.toString();
        } else if (type.includes("multipart/form-data") || options.data instanceof FormData) {
          const form = new FormData();
          if (options.data instanceof FormData) {
            options.data.forEach((value, key) => {
              form.append(key, value);
            });
          } else {
            for (const key of Object.keys(options.data)) {
              form.append(key, options.data[key]);
            }
          }
          output.body = form;
          const headers2 = new Headers(output.headers);
          headers2.delete("content-type");
          output.headers = headers2;
        } else if (type.includes("application/json") || typeof options.data === "object") {
          output.body = JSON.stringify(options.data);
        }
        return output;
      };
      CapacitorHttpPluginWeb = class extends WebPlugin {
        /**
         * Perform an Http request given a set of options
         * @param options Options to build the HTTP request
         */
        async request(options) {
          const requestInit = buildRequestInit(options, options.webFetchExtra);
          const urlParams = buildUrlParams(options.params, options.shouldEncodeUrlParams);
          const url = urlParams ? `${options.url}?${urlParams}` : options.url;
          const response = await fetch(url, requestInit);
          const contentType = response.headers.get("content-type") || "";
          let { responseType = "text" } = response.ok ? options : {};
          if (contentType.includes("application/json")) {
            responseType = "json";
          }
          let data;
          let blob;
          switch (responseType) {
            case "arraybuffer":
            case "blob":
              blob = await response.blob();
              data = await readBlobAsBase64(blob);
              break;
            case "json":
              data = await response.json();
              break;
            case "document":
            case "text":
            default:
              data = await response.text();
          }
          const headers = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });
          return {
            data,
            headers,
            status: response.status,
            url: response.url
          };
        }
        /**
         * Perform an Http GET request given a set of options
         * @param options Options to build the HTTP request
         */
        async get(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "GET" }));
        }
        /**
         * Perform an Http POST request given a set of options
         * @param options Options to build the HTTP request
         */
        async post(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "POST" }));
        }
        /**
         * Perform an Http PUT request given a set of options
         * @param options Options to build the HTTP request
         */
        async put(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "PUT" }));
        }
        /**
         * Perform an Http PATCH request given a set of options
         * @param options Options to build the HTTP request
         */
        async patch(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "PATCH" }));
        }
        /**
         * Perform an Http DELETE request given a set of options
         * @param options Options to build the HTTP request
         */
        async delete(options) {
          return this.request(Object.assign(Object.assign({}, options), { method: "DELETE" }));
        }
      };
      CapacitorHttp = registerPlugin("CapacitorHttp", {
        web: () => new CapacitorHttpPluginWeb()
      });
    }
  });

  // node_modules/@capacitor/filesystem/dist/esm/definitions.js
  var Directory, Encoding;
  var init_definitions = __esm({
    "node_modules/@capacitor/filesystem/dist/esm/definitions.js"() {
      (function(Directory2) {
        Directory2["Documents"] = "DOCUMENTS";
        Directory2["Data"] = "DATA";
        Directory2["Library"] = "LIBRARY";
        Directory2["Cache"] = "CACHE";
        Directory2["External"] = "EXTERNAL";
        Directory2["ExternalStorage"] = "EXTERNAL_STORAGE";
        Directory2["ExternalCache"] = "EXTERNAL_CACHE";
        Directory2["LibraryNoCloud"] = "LIBRARY_NO_CLOUD";
        Directory2["Temporary"] = "TEMPORARY";
      })(Directory || (Directory = {}));
      (function(Encoding2) {
        Encoding2["UTF8"] = "utf8";
        Encoding2["ASCII"] = "ascii";
        Encoding2["UTF16"] = "utf16";
      })(Encoding || (Encoding = {}));
    }
  });

  // node_modules/@capacitor/filesystem/dist/esm/web.js
  var web_exports = {};
  __export(web_exports, {
    FilesystemWeb: () => FilesystemWeb
  });
  function resolve(path) {
    const posix = path.split("/").filter((item) => item !== ".");
    const newPosix = [];
    posix.forEach((item) => {
      if (item === ".." && newPosix.length > 0 && newPosix[newPosix.length - 1] !== "..") {
        newPosix.pop();
      } else {
        newPosix.push(item);
      }
    });
    return newPosix.join("/");
  }
  function isPathParent(parent, children) {
    parent = resolve(parent);
    children = resolve(children);
    const pathsA = parent.split("/");
    const pathsB = children.split("/");
    return parent !== children && pathsA.every((value, index) => value === pathsB[index]);
  }
  var FilesystemWeb;
  var init_web = __esm({
    "node_modules/@capacitor/filesystem/dist/esm/web.js"() {
      init_dist();
      init_definitions();
      FilesystemWeb = class _FilesystemWeb extends WebPlugin {
        constructor() {
          super(...arguments);
          this.DB_VERSION = 1;
          this.DB_NAME = "Disc";
          this._writeCmds = ["add", "put", "delete"];
          this.downloadFile = async (options) => {
            var _a, _b;
            const requestInit = buildRequestInit(options, options.webFetchExtra);
            const response = await fetch(options.url, requestInit);
            let blob;
            if (!options.progress)
              blob = await response.blob();
            else if (!(response === null || response === void 0 ? void 0 : response.body))
              blob = new Blob();
            else {
              const reader = response.body.getReader();
              let bytes = 0;
              const chunks = [];
              const contentType = response.headers.get("content-type");
              const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
              while (true) {
                const { done, value } = await reader.read();
                if (done)
                  break;
                chunks.push(value);
                bytes += (value === null || value === void 0 ? void 0 : value.length) || 0;
                const status = {
                  url: options.url,
                  bytes,
                  contentLength
                };
                this.notifyListeners("progress", status);
              }
              const allChunks = new Uint8Array(bytes);
              let position = 0;
              for (const chunk of chunks) {
                if (typeof chunk === "undefined")
                  continue;
                allChunks.set(chunk, position);
                position += chunk.length;
              }
              blob = new Blob([allChunks.buffer], { type: contentType || void 0 });
            }
            const result = await this.writeFile({
              path: options.path,
              directory: (_a = options.directory) !== null && _a !== void 0 ? _a : void 0,
              recursive: (_b = options.recursive) !== null && _b !== void 0 ? _b : false,
              data: blob
            });
            return { path: result.uri, blob };
          };
        }
        readFileInChunks(_options, _callback) {
          throw this.unavailable("Method not implemented.");
        }
        async initDb() {
          if (this._db !== void 0) {
            return this._db;
          }
          if (!("indexedDB" in window)) {
            throw this.unavailable("This browser doesn't support IndexedDB");
          }
          return new Promise((resolve2, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            request.onupgradeneeded = _FilesystemWeb.doUpgrade;
            request.onsuccess = () => {
              this._db = request.result;
              resolve2(request.result);
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () => {
              console.warn("db blocked");
            };
          });
        }
        static doUpgrade(event) {
          const eventTarget = event.target;
          const db = eventTarget.result;
          switch (event.oldVersion) {
            case 0:
            case 1:
            default: {
              if (db.objectStoreNames.contains("FileStorage")) {
                db.deleteObjectStore("FileStorage");
              }
              const store = db.createObjectStore("FileStorage", { keyPath: "path" });
              store.createIndex("by_folder", "folder");
            }
          }
        }
        async dbRequest(cmd, args) {
          const readFlag = this._writeCmds.indexOf(cmd) !== -1 ? "readwrite" : "readonly";
          return this.initDb().then((conn) => {
            return new Promise((resolve2, reject) => {
              const tx = conn.transaction(["FileStorage"], readFlag);
              const store = tx.objectStore("FileStorage");
              const req = store[cmd](...args);
              req.onsuccess = () => resolve2(req.result);
              req.onerror = () => reject(req.error);
            });
          });
        }
        async dbIndexRequest(indexName, cmd, args) {
          const readFlag = this._writeCmds.indexOf(cmd) !== -1 ? "readwrite" : "readonly";
          return this.initDb().then((conn) => {
            return new Promise((resolve2, reject) => {
              const tx = conn.transaction(["FileStorage"], readFlag);
              const store = tx.objectStore("FileStorage");
              const index = store.index(indexName);
              const req = index[cmd](...args);
              req.onsuccess = () => resolve2(req.result);
              req.onerror = () => reject(req.error);
            });
          });
        }
        getPath(directory, uriPath) {
          const cleanedUriPath = uriPath !== void 0 ? uriPath.replace(/^[/]+|[/]+$/g, "") : "";
          let fsPath = "";
          if (directory !== void 0)
            fsPath += "/" + directory;
          if (uriPath !== "")
            fsPath += "/" + cleanedUriPath;
          return fsPath;
        }
        async clear() {
          const conn = await this.initDb();
          const tx = conn.transaction(["FileStorage"], "readwrite");
          const store = tx.objectStore("FileStorage");
          store.clear();
        }
        /**
         * Read a file from disk
         * @param options options for the file read
         * @return a promise that resolves with the read file data result
         */
        async readFile(options) {
          const path = this.getPath(options.directory, options.path);
          const entry = await this.dbRequest("get", [path]);
          if (entry === void 0)
            throw Error("File does not exist.");
          return { data: entry.content ? entry.content : "" };
        }
        /**
         * Write a file to disk in the specified location on device
         * @param options options for the file write
         * @return a promise that resolves with the file write result
         */
        async writeFile(options) {
          const path = this.getPath(options.directory, options.path);
          let data = options.data;
          const encoding = options.encoding;
          const doRecursive = options.recursive;
          const occupiedEntry = await this.dbRequest("get", [path]);
          if (occupiedEntry && occupiedEntry.type === "directory")
            throw Error("The supplied path is a directory.");
          const parentPath = path.substr(0, path.lastIndexOf("/"));
          const parentEntry = await this.dbRequest("get", [parentPath]);
          if (parentEntry === void 0) {
            const subDirIndex = parentPath.indexOf("/", 1);
            if (subDirIndex !== -1) {
              const parentArgPath = parentPath.substr(subDirIndex);
              await this.mkdir({
                path: parentArgPath,
                directory: options.directory,
                recursive: doRecursive
              });
            }
          }
          if (!encoding && !(data instanceof Blob)) {
            data = data.indexOf(",") >= 0 ? data.split(",")[1] : data;
            if (!this.isBase64String(data))
              throw Error("The supplied data is not valid base64 content.");
          }
          const now = Date.now();
          const pathObj = {
            path,
            folder: parentPath,
            type: "file",
            size: data instanceof Blob ? data.size : data.length,
            ctime: now,
            mtime: now,
            content: data
          };
          await this.dbRequest("put", [pathObj]);
          return {
            uri: pathObj.path
          };
        }
        /**
         * Append to a file on disk in the specified location on device
         * @param options options for the file append
         * @return a promise that resolves with the file write result
         */
        async appendFile(options) {
          const path = this.getPath(options.directory, options.path);
          let data = options.data;
          const encoding = options.encoding;
          const parentPath = path.substr(0, path.lastIndexOf("/"));
          const now = Date.now();
          let ctime = now;
          const occupiedEntry = await this.dbRequest("get", [path]);
          if (occupiedEntry && occupiedEntry.type === "directory")
            throw Error("The supplied path is a directory.");
          const parentEntry = await this.dbRequest("get", [parentPath]);
          if (parentEntry === void 0) {
            const subDirIndex = parentPath.indexOf("/", 1);
            if (subDirIndex !== -1) {
              const parentArgPath = parentPath.substr(subDirIndex);
              await this.mkdir({
                path: parentArgPath,
                directory: options.directory,
                recursive: true
              });
            }
          }
          if (!encoding && !this.isBase64String(data))
            throw Error("The supplied data is not valid base64 content.");
          if (occupiedEntry !== void 0) {
            if (occupiedEntry.content instanceof Blob) {
              throw Error("The occupied entry contains a Blob object which cannot be appended to.");
            }
            if (occupiedEntry.content !== void 0 && !encoding) {
              data = btoa(atob(occupiedEntry.content) + atob(data));
            } else {
              data = occupiedEntry.content + data;
            }
            ctime = occupiedEntry.ctime;
          }
          const pathObj = {
            path,
            folder: parentPath,
            type: "file",
            size: data.length,
            ctime,
            mtime: now,
            content: data
          };
          await this.dbRequest("put", [pathObj]);
        }
        /**
         * Delete a file from disk
         * @param options options for the file delete
         * @return a promise that resolves with the deleted file data result
         */
        async deleteFile(options) {
          const path = this.getPath(options.directory, options.path);
          const entry = await this.dbRequest("get", [path]);
          if (entry === void 0)
            throw Error("File does not exist.");
          const entries = await this.dbIndexRequest("by_folder", "getAllKeys", [IDBKeyRange.only(path)]);
          if (entries.length !== 0)
            throw Error("Folder is not empty.");
          await this.dbRequest("delete", [path]);
        }
        /**
         * Create a directory.
         * @param options options for the mkdir
         * @return a promise that resolves with the mkdir result
         */
        async mkdir(options) {
          const path = this.getPath(options.directory, options.path);
          const doRecursive = options.recursive;
          const parentPath = path.substr(0, path.lastIndexOf("/"));
          const depth = (path.match(/\//g) || []).length;
          const parentEntry = await this.dbRequest("get", [parentPath]);
          const occupiedEntry = await this.dbRequest("get", [path]);
          if (depth === 1)
            throw Error("Cannot create Root directory");
          if (occupiedEntry !== void 0)
            throw Error("Current directory does already exist.");
          if (!doRecursive && depth !== 2 && parentEntry === void 0)
            throw Error("Parent directory must exist");
          if (doRecursive && depth !== 2 && parentEntry === void 0) {
            const parentArgPath = parentPath.substr(parentPath.indexOf("/", 1));
            await this.mkdir({
              path: parentArgPath,
              directory: options.directory,
              recursive: doRecursive
            });
          }
          const now = Date.now();
          const pathObj = {
            path,
            folder: parentPath,
            type: "directory",
            size: 0,
            ctime: now,
            mtime: now
          };
          await this.dbRequest("put", [pathObj]);
        }
        /**
         * Remove a directory
         * @param options the options for the directory remove
         */
        async rmdir(options) {
          const { path, directory, recursive } = options;
          const fullPath = this.getPath(directory, path);
          const entry = await this.dbRequest("get", [fullPath]);
          if (entry === void 0)
            throw Error("Folder does not exist.");
          if (entry.type !== "directory")
            throw Error("Requested path is not a directory");
          const readDirResult = await this.readdir({ path, directory });
          if (readDirResult.files.length !== 0 && !recursive)
            throw Error("Folder is not empty");
          for (const entry2 of readDirResult.files) {
            const entryPath = `${path}/${entry2.name}`;
            const entryObj = await this.stat({ path: entryPath, directory });
            if (entryObj.type === "file") {
              await this.deleteFile({ path: entryPath, directory });
            } else {
              await this.rmdir({ path: entryPath, directory, recursive });
            }
          }
          await this.dbRequest("delete", [fullPath]);
        }
        /**
         * Return a list of files from the directory (not recursive)
         * @param options the options for the readdir operation
         * @return a promise that resolves with the readdir directory listing result
         */
        async readdir(options) {
          const path = this.getPath(options.directory, options.path);
          const entry = await this.dbRequest("get", [path]);
          if (options.path !== "" && entry === void 0)
            throw Error("Folder does not exist.");
          const entries = await this.dbIndexRequest("by_folder", "getAllKeys", [IDBKeyRange.only(path)]);
          const files = await Promise.all(entries.map(async (e) => {
            let subEntry = await this.dbRequest("get", [e]);
            if (subEntry === void 0) {
              subEntry = await this.dbRequest("get", [e + "/"]);
            }
            return {
              name: e.substring(path.length + 1),
              type: subEntry.type,
              size: subEntry.size,
              ctime: subEntry.ctime,
              mtime: subEntry.mtime,
              uri: subEntry.path
            };
          }));
          return { files };
        }
        /**
         * Return full File URI for a path and directory
         * @param options the options for the stat operation
         * @return a promise that resolves with the file stat result
         */
        async getUri(options) {
          const path = this.getPath(options.directory, options.path);
          let entry = await this.dbRequest("get", [path]);
          if (entry === void 0) {
            entry = await this.dbRequest("get", [path + "/"]);
          }
          return {
            uri: (entry === null || entry === void 0 ? void 0 : entry.path) || path
          };
        }
        /**
         * Return data about a file
         * @param options the options for the stat operation
         * @return a promise that resolves with the file stat result
         */
        async stat(options) {
          const path = this.getPath(options.directory, options.path);
          let entry = await this.dbRequest("get", [path]);
          if (entry === void 0) {
            entry = await this.dbRequest("get", [path + "/"]);
          }
          if (entry === void 0)
            throw Error("Entry does not exist.");
          return {
            name: entry.path.substring(path.length + 1),
            type: entry.type,
            size: entry.size,
            ctime: entry.ctime,
            mtime: entry.mtime,
            uri: entry.path
          };
        }
        /**
         * Rename a file or directory
         * @param options the options for the rename operation
         * @return a promise that resolves with the rename result
         */
        async rename(options) {
          await this._copy(options, true);
          return;
        }
        /**
         * Copy a file or directory
         * @param options the options for the copy operation
         * @return a promise that resolves with the copy result
         */
        async copy(options) {
          return this._copy(options, false);
        }
        async requestPermissions() {
          return { publicStorage: "granted" };
        }
        async checkPermissions() {
          return { publicStorage: "granted" };
        }
        /**
         * Function that can perform a copy or a rename
         * @param options the options for the rename operation
         * @param doRename whether to perform a rename or copy operation
         * @return a promise that resolves with the result
         */
        async _copy(options, doRename = false) {
          let { toDirectory } = options;
          const { to, from, directory: fromDirectory } = options;
          if (!to || !from) {
            throw Error("Both to and from must be provided");
          }
          if (!toDirectory) {
            toDirectory = fromDirectory;
          }
          const fromPath = this.getPath(fromDirectory, from);
          const toPath = this.getPath(toDirectory, to);
          if (fromPath === toPath) {
            return {
              uri: toPath
            };
          }
          if (isPathParent(fromPath, toPath)) {
            throw Error("To path cannot contain the from path");
          }
          let toObj;
          try {
            toObj = await this.stat({
              path: to,
              directory: toDirectory
            });
          } catch (e) {
            const toPathComponents = to.split("/");
            toPathComponents.pop();
            const toPath2 = toPathComponents.join("/");
            if (toPathComponents.length > 0) {
              const toParentDirectory = await this.stat({
                path: toPath2,
                directory: toDirectory
              });
              if (toParentDirectory.type !== "directory") {
                throw new Error("Parent directory of the to path is a file");
              }
            }
          }
          if (toObj && toObj.type === "directory") {
            throw new Error("Cannot overwrite a directory with a file");
          }
          const fromObj = await this.stat({
            path: from,
            directory: fromDirectory
          });
          const updateTime = async (path, ctime2, mtime) => {
            const fullPath = this.getPath(toDirectory, path);
            const entry = await this.dbRequest("get", [fullPath]);
            entry.ctime = ctime2;
            entry.mtime = mtime;
            await this.dbRequest("put", [entry]);
          };
          const ctime = fromObj.ctime ? fromObj.ctime : Date.now();
          switch (fromObj.type) {
            // The "from" object is a file
            case "file": {
              const file = await this.readFile({
                path: from,
                directory: fromDirectory
              });
              if (doRename) {
                await this.deleteFile({
                  path: from,
                  directory: fromDirectory
                });
              }
              let encoding;
              if (!(file.data instanceof Blob) && !this.isBase64String(file.data)) {
                encoding = Encoding.UTF8;
              }
              const writeResult = await this.writeFile({
                path: to,
                directory: toDirectory,
                data: file.data,
                encoding
              });
              if (doRename) {
                await updateTime(to, ctime, fromObj.mtime);
              }
              return writeResult;
            }
            case "directory": {
              if (toObj) {
                throw Error("Cannot move a directory over an existing object");
              }
              try {
                await this.mkdir({
                  path: to,
                  directory: toDirectory,
                  recursive: false
                });
                if (doRename) {
                  await updateTime(to, ctime, fromObj.mtime);
                }
              } catch (e) {
              }
              const contents = (await this.readdir({
                path: from,
                directory: fromDirectory
              })).files;
              for (const filename of contents) {
                await this._copy({
                  from: `${from}/${filename.name}`,
                  to: `${to}/${filename.name}`,
                  directory: fromDirectory,
                  toDirectory
                }, doRename);
              }
              if (doRename) {
                await this.rmdir({
                  path: from,
                  directory: fromDirectory
                });
              }
            }
          }
          return {
            uri: toPath
          };
        }
        isBase64String(str) {
          try {
            return btoa(atob(str)) == str;
          } catch (err) {
            return false;
          }
        }
      };
      FilesystemWeb._debug = true;
    }
  });

  // node_modules/@capacitor/app/dist/esm/web.js
  var web_exports2 = {};
  __export(web_exports2, {
    AppWeb: () => AppWeb
  });
  var AppWeb;
  var init_web2 = __esm({
    "node_modules/@capacitor/app/dist/esm/web.js"() {
      init_dist();
      AppWeb = class extends WebPlugin {
        constructor() {
          super();
          this.handleVisibilityChange = () => {
            const data = {
              isActive: document.hidden !== true
            };
            this.notifyListeners("appStateChange", data);
            if (document.hidden) {
              this.notifyListeners("pause", null);
            } else {
              this.notifyListeners("resume", null);
            }
          };
          document.addEventListener("visibilitychange", this.handleVisibilityChange, false);
        }
        exitApp() {
          throw this.unimplemented("Not implemented on web.");
        }
        async getInfo() {
          throw this.unimplemented("Not implemented on web.");
        }
        async getLaunchUrl() {
          return { url: "" };
        }
        async getState() {
          return { isActive: document.hidden !== true };
        }
        async minimizeApp() {
          throw this.unimplemented("Not implemented on web.");
        }
        async toggleBackButtonHandler() {
          throw this.unimplemented("Not implemented on web.");
        }
      };
    }
  });

  // node_modules/@capacitor/filesystem/dist/esm/index.js
  init_dist();

  // node_modules/@capacitor/synapse/dist/synapse.mjs
  function s(t) {
    t.CapacitorUtils.Synapse = new Proxy(
      {},
      {
        get(e, n) {
          return new Proxy({}, {
            get(w, o) {
              return (c, p, r) => {
                const i = t.Capacitor.Plugins[n];
                if (i === void 0) {
                  r(new Error(`Capacitor plugin ${n} not found`));
                  return;
                }
                if (typeof i[o] != "function") {
                  r(new Error(`Method ${o} not found in Capacitor plugin ${n}`));
                  return;
                }
                (async () => {
                  try {
                    const a = await i[o](c);
                    p(a);
                  } catch (a) {
                    r(a);
                  }
                })();
              };
            }
          });
        }
      }
    );
  }
  function u(t) {
    t.CapacitorUtils.Synapse = new Proxy(
      {},
      {
        get(e, n) {
          return t.cordova.plugins[n];
        }
      }
    );
  }
  function f(t = false) {
    typeof window > "u" || (window.CapacitorUtils = window.CapacitorUtils || {}, window.Capacitor !== void 0 && !t ? s(window) : window.cordova !== void 0 && u(window));
  }

  // node_modules/@capacitor/filesystem/dist/esm/index.js
  init_definitions();
  var Filesystem = registerPlugin("Filesystem", {
    web: () => Promise.resolve().then(() => (init_web(), web_exports)).then((m) => new m.FilesystemWeb())
  });
  f();

  // bridge/fs-adapter.mjs
  var ROOT = "SolaceLibrary";
  var DIR = Directory.External;
  var abs = (p) => `${ROOT}/${String(p).replace(/^\/+/, "")}`;
  async function statOf(p) {
    return Filesystem.stat({ path: abs(p), directory: DIR });
  }
  var fs = {
    // 文本读写（library.json、索引分片、笔记）
    async readFileText(p) {
      const r = await Filesystem.readFile({ path: abs(p), directory: DIR, encoding: Encoding.UTF8 });
      return r.data;
    },
    // base64 读写（PDF 副本、封面 jpg）
    async readFileB64(p) {
      const r = await Filesystem.readFile({ path: abs(p), directory: DIR });
      return r.data;
    },
    // 原子写：临时文件 + 重命名，与桌面端 atomicWriteFile 同语义
    async writeFileAtomicText(p, text) {
      const tmp = `${p}.tmp`;
      await Filesystem.writeFile({ path: abs(tmp), data: text, directory: DIR, encoding: Encoding.UTF8 });
      await Filesystem.rename({ from: abs(tmp), to: abs(p), directory: DIR, toDirectory: DIR });
    },
    async writeText(p, text) {
      await Filesystem.writeFile({ path: abs(p), data: text, directory: DIR, encoding: Encoding.UTF8 });
    },
    async writeB64(p, b64) {
      await Filesystem.writeFile({ path: abs(p), data: b64, directory: DIR });
    },
    async rename(from, to) {
      await Filesystem.rename({ from: abs(from), to: abs(to), directory: DIR, toDirectory: DIR });
    },
    async exists(p) {
      try {
        await statOf(p);
        return true;
      } catch {
        return false;
      }
    },
    // { type: 'file'|'directory', size, mtime(ms), ctime(ms) }
    async stat(p) {
      return statOf(p);
    },
    // [{ name, type }]
    async readdir(p) {
      const r = await Filesystem.readdir({ path: abs(p), directory: DIR });
      return r.files;
    },
    async mkdirp(p) {
      try {
        await Filesystem.mkdir({ path: abs(p), directory: DIR, recursive: true });
      } catch {
      }
    },
    // 删除文件或目录（目录需 recursive）；返回是否删除成功，不抛错。
    // 与桌面端 rmSync({force:true}) 对齐：目标不存在也视为成功（没东西可清
    // 就不报 leftover）
    async rm(p, { recursive = false } = {}) {
      let st;
      try {
        st = await statOf(p);
      } catch {
        return true;
      }
      try {
        if (st.type === "directory") {
          await Filesystem.rmdir({ path: abs(p), directory: DIR, recursive });
        } else {
          await Filesystem.deleteFile({ path: abs(p), directory: DIR });
        }
        return true;
      } catch {
        return false;
      }
    }
  };
  async function rootUri() {
    try {
      await fs.mkdirp("");
      return (await Filesystem.getUri({ path: ROOT, directory: DIR })).uri;
    } catch {
      return null;
    }
  }
  async function fileUrl(relPath) {
    const r = await Filesystem.getUri({ path: abs(relPath), directory: DIR });
    const p = String(r.uri).replace(/^file:\/\//, "");
    return `https://localhost/_capacitor_file_${p}`;
  }

  // bridge/base64.mjs
  var TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var LOOKUP = new Int16Array(128).fill(-1);
  for (let i = 0; i < TABLE.length; i++) LOOKUP[TABLE.charCodeAt(i)] = i;
  function bytesToBase64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += TABLE[b0 >> 2];
      out += TABLE[(b0 & 3) << 4 | b1 >> 4];
      out += i + 1 < bytes.length ? TABLE[(b1 & 15) << 2 | b2 >> 6] : "=";
      out += i + 2 < bytes.length ? TABLE[b2 & 63] : "=";
    }
    return out;
  }
  function base64ToBytes(b64) {
    const clean = String(b64).replace(/[\r\n\s=]/g, "");
    const out = new Uint8Array(Math.ceil(clean.length * 3 / 4));
    let o = 0;
    let buf = 0;
    let bits = 0;
    for (let i = 0; i < clean.length; i++) {
      const v = LOOKUP[clean.charCodeAt(i) & 127];
      if (v < 0) throw new Error("\u975E\u6CD5 base64 \u6570\u636E");
      buf = buf << 6 | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = buf >> bits & 255;
      }
    }
    return out.subarray(0, o);
  }

  // bridge/library-core.mjs
  function createLibrary({ fs: fs2, sha256, randomUUID: randomUUID2, now = () => /* @__PURE__ */ new Date() }) {
    let data = null;
    let startupNotice = null;
    let textIndexMeta = { version: 1, entries: {} };
    let legacyMigrationDone = false;
    async function init() {
      startupNotice = null;
      try {
        await loadRoot();
      } catch (err) {
        try {
          await fs2.rename("library.json", "library.json.corrupt");
        } catch {
        }
        startupNotice = "\u8D44\u6599\u5E93\u6570\u636E\u6587\u4EF6\u635F\u574F\uFF0C\u5DF2\u65B0\u5EFA\u7A7A\u8D44\u6599\u5E93\u3002\n\u539F\u6587\u4EF6\u4FDD\u7559\u4E3A\u8D44\u6599\u5E93\u5185 library.json.corrupt\uFF0C\u5E93\u5185 PDF \u526F\u672C\u4E0E\u5168\u6587\u7D22\u5F15\u672A\u5220\u9664\uFF0C\u53EF\u624B\u52A8\u53D6\u56DE\u6216\u91CD\u65B0\u5BFC\u5165\u3002";
        await loadRoot({ sweep: false });
      }
    }
    async function loadRoot(opts = {}) {
      await fs2.mkdirp("files");
      await fs2.mkdirp("covers");
      await fs2.mkdirp("textindex");
      if (await fs2.exists("library.json")) {
        data = JSON.parse(await fs2.readFileText("library.json"));
        assertLibraryShape();
      } else {
        data = {
          version: 1,
          createdAt: now().toISOString(),
          categories: [],
          // { id, name, parentId: null }，parentId 构成分类树
          tags: [],
          // { id, name }
          documents: [],
          // 见 importFile()
          history: [],
          // 打开事件 { docId, at, type }
          smartShelves: [],
          // { id, name, filters }
          settings: { theme: "auto", viewMode: "grid" }
        };
        await save();
      }
      if (!Array.isArray(data.history)) data.history = [];
      if (!Array.isArray(data.smartShelves)) data.smartShelves = [];
      if (!data.settings) data.settings = { theme: "auto", viewMode: "grid" };
      normalizeDocuments();
      normalizeOpenDays();
      shardCache.clear();
      shardCacheChars = 0;
      legacyMigrationDone = false;
      textIndexMeta = await readTextIndexMeta();
      if (opts.sweep !== false) await pruneTextIndexMeta();
      if (opts.sweep !== false) await sweepOrphans();
    }
    function getData() {
      return structuredClone(data);
    }
    function getStartupNotice() {
      return startupNotice;
    }
    function assertLibraryShape(obj = data) {
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("\u4E0D\u662F\u5BF9\u8C61");
      for (const key of ["documents", "categories", "tags"]) {
        if (!Array.isArray(obj[key])) throw new Error(`\u7F3A\u5C11 ${key} \u96C6\u5408`);
      }
    }
    async function save() {
      await fs2.writeFileAtomicText("library.json", JSON.stringify(data, null, 2));
    }
    const stemOf = (name) => String(name || "").replace(/\.[^.\\/]+$/, "");
    function normalizeDocuments() {
      for (const d of data.documents) {
        if (!Array.isArray(d.tagIds)) d.tagIds = [];
        if (d.categoryId === void 0) d.categoryId = null;
        if (!Number.isFinite(d.openCount)) d.openCount = 0;
        if (typeof d.title !== "string" || !d.title) d.title = stemOf(d.fileName) || "\u672A\u547D\u540D\u6587\u6863";
      }
    }
    function findDoc(id) {
      const doc = data.documents.find((d) => d.id === id);
      if (!doc) throw new Error(`\u6587\u6863\u4E0D\u5B58\u5728: ${id}`);
      return doc;
    }
    async function findDuplicate(hash, size) {
      let backfilled = false;
      let dup = null;
      for (const d of data.documents) {
        if (d.hash) {
          if (d.hash === hash) {
            dup = d;
            break;
          }
          continue;
        }
        if (d.size !== size) continue;
        try {
          d.hash = await sha256(base64ToBytes(await fs2.readFileB64(`files/${d.id}.pdf`)));
          backfilled = true;
          if (d.hash === hash) dup = d;
        } catch {
        }
        if (dup) break;
      }
      if (backfilled) await save();
      return dup;
    }
    let importChain = Promise.resolve();
    function enqueue(run) {
      const p = importChain.then(run);
      importChain = p.then(() => {
      }, () => {
      });
      return p;
    }
    function importWith(meta, performCopy) {
      return enqueue(() => importWithLocked(meta, performCopy));
    }
    async function importWithLocked(meta, performCopy) {
      const name = String(meta.fileName || "");
      if (!name.toLowerCase().endsWith(".pdf")) throw new Error("\u4EC5\u652F\u6301 PDF \u6587\u4EF6");
      const size = Math.floor(Number(meta.size));
      const hash = String(meta.hash || "");
      if (!Number.isFinite(size) || size < 0) throw new Error("\u65E0\u6548\u7684\u6587\u4EF6\u5927\u5C0F");
      if (!hash) throw new Error("\u7F3A\u5C11\u5185\u5BB9\u54C8\u5E0C");
      const dup = await findDuplicate(hash, size);
      if (dup) {
        const err = new Error(`\u4E0E\u5DF2\u5165\u5E93\u7684\u300A${dup.title}\u300B\u5185\u5BB9\u76F8\u540C`);
        err.duplicate = { title: dup.title, docId: dup.id };
        throw err;
      }
      const id = randomUUID2();
      await performCopy(`files/${id}.pdf`);
      const doc = {
        id,
        title: stemOf(name),
        fileName: name,
        originalPath: null,
        // 平板端拿不到来源路径；字段保留，两端数据形状一致
        size,
        hash,
        addedAt: now().toISOString(),
        openedAt: null,
        openCount: 0,
        categoryId: null,
        tagIds: []
      };
      data.documents.push(doc);
      await save();
      return doc;
    }
    function importFile(file) {
      const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
      const name = String(file.fileName || "");
      if (!name.toLowerCase().endsWith(".pdf")) {
        return enqueue(async () => {
          throw new Error("\u4EC5\u652F\u6301 PDF \u6587\u4EF6");
        });
      }
      return (async () => {
        const size = Number.isFinite(file.size) ? file.size : bytes.length;
        const hash = await sha256(bytes);
        return importWith({ fileName: name, size, hash }, async (dest) => {
          await fs2.writeB64(dest, bytesToBase64(bytes));
        });
      })();
    }
    async function updateDoc(id, patch) {
      const doc = findDoc(id);
      if ("title" in patch) {
        const t = String(patch.title == null ? "" : patch.title).trim();
        doc.title = t || stemOf(doc.fileName) || "\u672A\u547D\u540D\u6587\u6863";
      }
      if ("categoryId" in patch) {
        doc.categoryId = patch.categoryId == null ? null : String(patch.categoryId);
      }
      if ("tagIds" in patch) {
        doc.tagIds = Array.isArray(patch.tagIds) ? patch.tagIds.map(String) : doc.tagIds;
      }
      await save();
      return structuredClone(doc);
    }
    async function removeDoc(id, opts = {}) {
      const doc = findDoc(id);
      data.documents = data.documents.filter((d) => d.id !== id);
      if (textIndexMeta.entries[id]) {
        delete textIndexMeta.entries[id];
        await saveTextIndexMeta();
        dropShardCache(id);
      }
      await save();
      const leftovers = [];
      const base = (p) => p.split("/").pop();
      for (const p of [`files/${doc.id}.pdf`, `covers/${doc.id}.jpg`, `textindex/${doc.id}.json`]) {
        if (!await fs2.rm(p)) leftovers.push(base(p));
      }
      let notesKeptTo = null;
      let notesPurged = false;
      const notesDir = `notes/${doc.id}`;
      if (opts.keepNotes && await fs2.exists(notesDir)) {
        const safe = String(doc.title || "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 40).replace(/[\s.]+$/, "").trim() || "\u672A\u547D\u540D";
        const p = (n2) => String(n2).padStart(2, "0");
        const t = now();
        const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
        let dest = `notes/\u5DF2\u5220\u4E66-${safe}-${stamp}`;
        let n = 2;
        while (await fs2.exists(dest)) dest = `notes/\u5DF2\u5220\u4E66-${safe}-${stamp} (${n++})`;
        try {
          await fs2.rename(notesDir, dest);
          notesKeptTo = base(dest);
        } catch {
        }
      } else if (await fs2.exists(notesDir)) {
        if (await fs2.rm(notesDir, { recursive: true })) notesPurged = true;
        else leftovers.push(base(notesDir));
      }
      return { title: doc.title, leftovers, notesKeptTo, notesPurged };
    }
    async function readFileBuffer(id) {
      findDoc(id);
      try {
        return base64ToBytes(await fs2.readFileB64(`files/${findDoc(id).id}.pdf`));
      } catch {
        throw new Error("\u5E93\u5185 PDF \u526F\u672C\u5DF2\u4E22\u5931\uFF0C\u8BF7\u5220\u9664\u8FD9\u672C\u4E66\u540E\u91CD\u65B0\u5BFC\u5165\uFF08\u539F\u6587\u4EF6\u4E0D\u53D7\u5F71\u54CD\uFF09");
      }
    }
    async function markOpened(id, type = "open") {
      const doc = findDoc(id);
      doc.openedAt = now().toISOString();
      doc.openCount += 1;
      data.history.push({ docId: id, at: doc.openedAt, type });
      if (data.history.length > 200) data.history = data.history.slice(-200);
      countOpenDay(doc.openedAt);
      await save();
    }
    const OPEN_DAYS_KEEP = 400;
    const dayKey = (d) => {
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };
    function countOpenDay(at) {
      if (!data.openDays || typeof data.openDays !== "object") data.openDays = {};
      const k = dayKey(new Date(at));
      data.openDays[k] = (data.openDays[k] || 0) + 1;
      const keys = Object.keys(data.openDays);
      if (keys.length > OPEN_DAYS_KEEP) {
        keys.sort();
        for (const old of keys.slice(0, keys.length - OPEN_DAYS_KEEP)) delete data.openDays[old];
      }
    }
    function getOpenStats() {
      const days = data.openDays || {};
      const d = now();
      let opens7d = 0;
      let opens30d = 0;
      for (let i = 0; i < 30; i++) {
        const n = days[dayKey(d)] || 0;
        if (i < 7) opens7d += n;
        opens30d += n;
        d.setDate(d.getDate() - 1);
      }
      return { opens7d, opens30d };
    }
    function normalizeOpenDays() {
      if (data.openDays && typeof data.openDays === "object") return;
      data.openDays = {};
      for (const h of data.history) {
        if (!h || !h.at) continue;
        const d = new Date(h.at);
        if (Number.isNaN(d.getTime())) continue;
        const k = dayKey(d);
        data.openDays[k] = (data.openDays[k] || 0) + 1;
      }
    }
    async function setProgress(id, page, totalPages) {
      const doc = findDoc(id);
      page = Math.floor(Number(page));
      totalPages = Math.floor(Number(totalPages));
      if (!(page >= 1) || !(totalPages >= 1)) return structuredClone(doc);
      doc.progress = { page: Math.min(page, totalPages), totalPages, at: now().toISOString() };
      await save();
      return structuredClone(doc);
    }
    async function setCover(id, dataUrl) {
      findDoc(id);
      const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(String(dataUrl || ""));
      if (!m) throw new Error("\u65E0\u6548\u7684\u5C01\u9762\u6570\u636E");
      await fs2.writeB64(`covers/${id}.jpg`, m[2]);
      findDoc(id).hasCover = true;
      await save();
      return true;
    }
    async function getCoverDataUrl(id) {
      findDoc(id);
      if (!await fs2.exists(`covers/${id}.jpg`)) return null;
      return `data:image/jpeg;base64,${await fs2.readFileB64(`covers/${id}.jpg`)}`;
    }
    const normalizeKeyword = (s2) => String(s2 || "").toLowerCase().replace(/\s+/g, "");
    const shardCache = /* @__PURE__ */ new Map();
    let shardCacheChars = 0;
    const SHARD_CACHE_MAX_CHARS = 32 * 1024 * 1024;
    function cacheShard(id, pages) {
      let chars = 0;
      for (const p of pages) chars += p.length;
      if (chars > SHARD_CACHE_MAX_CHARS) return;
      const old = shardCache.get(id);
      if (old) {
        shardCache.delete(id);
        shardCacheChars -= old.chars;
      }
      shardCache.set(id, { pages, chars });
      shardCacheChars += chars;
      for (const [key, val] of shardCache) {
        if (shardCacheChars <= SHARD_CACHE_MAX_CHARS) break;
        if (key === id) continue;
        shardCache.delete(key);
        shardCacheChars -= val.chars;
      }
    }
    function dropShardCache(id) {
      const old = shardCache.get(id);
      if (!old) return;
      shardCache.delete(id);
      shardCacheChars -= old.chars;
    }
    async function writeShard(id, entry) {
      await fs2.writeFileAtomicText(`textindex/${id}.json`, JSON.stringify({
        pages: Array.isArray(entry.pages) ? entry.pages.map(String) : [],
        failed: !!entry.failed,
        ver: Number(entry.ver) || void 0,
        at: entry.at || now().toISOString()
      }));
    }
    async function readTextIndexMeta() {
      let raw;
      try {
        raw = await fs2.readFileText("textindex/index.json");
      } catch {
        return { version: 1, entries: {} };
      }
      try {
        const obj = JSON.parse(raw);
        if (obj && obj.entries && typeof obj.entries === "object" && !Array.isArray(obj.entries)) {
          return { version: 1, entries: obj.entries };
        }
      } catch {
      }
      try {
        await fs2.rename("textindex/index.json", "textindex/index.json.corrupt");
      } catch {
      }
      return { version: 1, entries: {} };
    }
    async function saveTextIndexMeta() {
      await fs2.writeFileAtomicText("textindex/index.json", JSON.stringify(textIndexMeta));
    }
    async function pruneTextIndexMeta() {
      const ids = new Set(data.documents.map((d) => d.id));
      let changed = false;
      for (const id of Object.keys(textIndexMeta.entries)) {
        if (!ids.has(id)) {
          delete textIndexMeta.entries[id];
          dropShardCache(id);
          changed = true;
        }
      }
      if (changed) await saveTextIndexMeta();
    }
    async function migrateLegacyTextIndex() {
      if (legacyMigrationDone) return;
      legacyMigrationDone = true;
      if (!await fs2.exists("textindex.json")) return;
      try {
        const old = JSON.parse(await fs2.readFileText("textindex.json"));
        for (const [id, e] of Object.entries(old || {})) {
          if (!e || !Array.isArray(e.pages)) continue;
          await writeShard(id, e);
          textIndexMeta.entries[id] = { ver: Number(e.ver) || void 0, failed: !!e.failed, at: e.at };
        }
        await saveTextIndexMeta();
        await fs2.rename("textindex.json", "textindex.json.migrated");
      } catch {
        try {
          await fs2.rename("textindex.json", "textindex.json.corrupt");
        } catch {
        }
      }
    }
    async function getTextIndexStatus() {
      await migrateLegacyTextIndex();
      const out = {};
      for (const [id, e] of Object.entries(textIndexMeta.entries)) {
        out[id] = { ver: e.ver, failed: !!e.failed };
      }
      return out;
    }
    async function readShardPages(id) {
      const cached = shardCache.get(id);
      if (cached) return cached.pages;
      let obj;
      try {
        obj = JSON.parse(await fs2.readFileText(`textindex/${id}.json`));
      } catch {
        return null;
      }
      if (!obj || !Array.isArray(obj.pages)) return null;
      cacheShard(id, obj.pages);
      return obj.pages;
    }
    async function searchTextIndex(kw) {
      const needle = normalizeKeyword(kw);
      if (!needle) return {};
      await migrateLegacyTextIndex();
      const live = new Set(data.documents.map((d) => d.id));
      const hits = {};
      const ids = Object.keys(textIndexMeta.entries).filter((id) => live.has(id) && !textIndexMeta.entries[id].failed);
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const pages = await readShardPages(id);
        if (pages) {
          for (let n = 0; n < pages.length; n++) {
            if (pages[n].includes(needle)) {
              hits[id] = n + 1;
              break;
            }
          }
        } else {
          delete textIndexMeta.entries[id];
          await saveTextIndexMeta();
        }
        if ((i & 15) === 15) await new Promise((r) => setTimeout(r, 0));
      }
      return hits;
    }
    async function setTextIndex(id, payload) {
      findDoc(id);
      await migrateLegacyTextIndex();
      const entry = {
        pages: Array.isArray(payload && payload.pages) ? payload.pages.map(String) : [],
        failed: !!(payload && payload.failed),
        ver: Number(payload && payload.ver) || void 0,
        at: now().toISOString()
      };
      await writeShard(id, entry);
      textIndexMeta.entries[id] = { ver: entry.ver, failed: entry.failed, at: entry.at };
      await saveTextIndexMeta();
      dropShardCache(id);
      return true;
    }
    const APP_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(pdf|jpg)$/i;
    const APP_TMP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.tmp$/i;
    async function sweepOrphans() {
      await fs2.rm("library.json.tmp");
      await fs2.rm("textindex/index.json.tmp");
      let shards = [];
      try {
        shards = await fs2.readdir("textindex");
      } catch {
      }
      for (const e of shards) {
        if (APP_TMP_RE.test(e.name)) await fs2.rm(`textindex/${e.name}`);
      }
      if (!data.documents.length) return;
      const ids = new Set(data.documents.map((d) => d.id));
      for (const sub of ["files", "covers"]) {
        let entries;
        try {
          entries = await fs2.readdir(sub);
        } catch {
          continue;
        }
        for (const e of entries) {
          const m = APP_FILE_RE.exec(e.name);
          if (!m || ids.has(m[1])) continue;
          await fs2.rm(`${sub}/${e.name}`);
        }
      }
    }
    async function addCategory(name, parentId = null) {
      const trimmed = String(name || "").trim();
      if (!trimmed) throw new Error("\u5206\u7C7B\u540D\u4E0D\u80FD\u4E3A\u7A7A");
      if (parentId != null && !data.categories.some((c) => c.id === parentId)) throw new Error("\u7236\u5206\u7C7B\u4E0D\u5B58\u5728");
      if (data.categories.some((c) => c.name === trimmed)) throw new Error(`\u5206\u7C7B\u5DF2\u5B58\u5728: ${trimmed}`);
      const cat = { id: randomUUID2(), name: trimmed, parentId: parentId || null };
      data.categories.push(cat);
      await save();
      return cat;
    }
    async function moveCategory(id, parentId) {
      const cat = data.categories.find((c) => c.id === id);
      if (!cat) throw new Error(`\u5206\u7C7B\u4E0D\u5B58\u5728: ${id}`);
      const target = parentId || null;
      if (target === id) throw new Error("\u4E0D\u80FD\u79FB\u52A8\u5230\u81EA\u8EAB");
      if (target != null) {
        let cursor = data.categories.find((c) => c.id === target);
        if (!cursor) throw new Error("\u76EE\u6807\u5206\u7C7B\u4E0D\u5B58\u5728");
        const seen = /* @__PURE__ */ new Set();
        while (cursor) {
          if (cursor.id === id) throw new Error("\u4E0D\u80FD\u79FB\u52A8\u5230\u81EA\u5DF1\u7684\u5B50\u5206\u7C7B\u4E0B");
          if (seen.has(cursor.id)) throw new Error("\u5206\u7C7B\u5C42\u7EA7\u6570\u636E\u5F02\u5E38\uFF08parentId \u6210\u73AF\uFF09\uFF0C\u8BF7\u5148\u4FEE\u590D library.json");
          seen.add(cursor.id);
          cursor = data.categories.find((c) => c.id === cursor.parentId) || null;
        }
      }
      if (cat.parentId === target) return cat;
      cat.parentId = target;
      await save();
      return cat;
    }
    async function renameCategory(id, name) {
      const cat = data.categories.find((c) => c.id === id);
      if (!cat) throw new Error(`\u5206\u7C7B\u4E0D\u5B58\u5728: ${id}`);
      const trimmed = String(name || "").trim();
      if (!trimmed) throw new Error("\u5206\u7C7B\u540D\u4E0D\u80FD\u4E3A\u7A7A");
      if (data.categories.some((c) => c.id !== id && c.name === trimmed)) throw new Error(`\u5206\u7C7B\u5DF2\u5B58\u5728: ${trimmed}`);
      cat.name = trimmed;
      await save();
      return cat;
    }
    async function removeCategory(id) {
      const cat = data.categories.find((c) => c.id === id);
      if (!cat) throw new Error(`\u5206\u7C7B\u4E0D\u5B58\u5728: ${id}`);
      const parentId = cat.parentId || null;
      data.categories.forEach((c) => {
        if (c.parentId === id) c.parentId = parentId;
      });
      data.documents.forEach((d) => {
        if (d.categoryId === id) d.categoryId = parentId;
      });
      for (const s2 of data.smartShelves || []) {
        if (s2.filters && s2.filters.categoryId === id) s2.filters.categoryId = parentId;
      }
      data.categories = data.categories.filter((c) => c.id !== id);
      await save();
      return true;
    }
    async function addTag(name) {
      const trimmed = String(name || "").trim();
      if (!trimmed) throw new Error("\u6807\u7B7E\u540D\u4E0D\u80FD\u4E3A\u7A7A");
      const existed = data.tags.find((t) => t.name === trimmed);
      if (existed) return existed;
      const tag = { id: randomUUID2(), name: trimmed };
      data.tags.push(tag);
      await save();
      return tag;
    }
    async function removeTag(id) {
      data.documents.forEach((d) => {
        if (Array.isArray(d.tagIds)) d.tagIds = d.tagIds.filter((t) => t !== id);
      });
      data.tags = data.tags.filter((t) => t.id !== id);
      for (const s2 of data.smartShelves || []) {
        if (s2.filters && s2.filters.tagId === id) delete s2.filters.tagId;
      }
      await save();
      return true;
    }
    async function addSmartShelf(name, filters) {
      const trimmed = String(name || "").trim();
      if (!trimmed) throw new Error("\u6536\u85CF\u5939\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
      if (data.smartShelves.some((s2) => s2.name === trimmed)) throw new Error(`\u6536\u85CF\u5939\u5DF2\u5B58\u5728: ${trimmed}`);
      const clean = {};
      if (filters && filters.categoryId !== void 0) clean.categoryId = filters.categoryId;
      if (filters && filters.tagId) clean.tagId = filters.tagId;
      if (filters && filters.keyword) clean.keyword = filters.keyword;
      if (!Object.keys(clean).length) throw new Error("\u5F53\u524D\u6CA1\u6709\u53EF\u4FDD\u5B58\u7684\u7B5B\u9009\u6761\u4EF6");
      const shelf = { id: randomUUID2(), name: trimmed, filters: clean };
      data.smartShelves.push(shelf);
      await save();
      return shelf;
    }
    async function renameSmartShelf(id, name) {
      const shelf = data.smartShelves.find((s2) => s2.id === id);
      if (!shelf) throw new Error(`\u6536\u85CF\u5939\u4E0D\u5B58\u5728: ${id}`);
      const trimmed = String(name || "").trim();
      if (!trimmed) throw new Error("\u6536\u85CF\u5939\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
      if (data.smartShelves.some((s2) => s2.id !== id && s2.name === trimmed)) throw new Error(`\u6536\u85CF\u5939\u5DF2\u5B58\u5728: ${trimmed}`);
      shelf.name = trimmed;
      await save();
      return shelf;
    }
    async function removeSmartShelf(id) {
      data.smartShelves = data.smartShelves.filter((s2) => s2.id !== id);
      await save();
      return true;
    }
    async function updateSettings(patch) {
      if (!data.settings) data.settings = {};
      const strings = [
        "notesEditorPath",
        "pdfReaderPath",
        "externalToolPath",
        "watchFolder",
        "watchCategory",
        "watchTreeUri",
        "watchFolderName",
        "externalToolPackage"
      ];
      const booleans = ["resumeReading", "confetti", "openingAnimation", "watchEnabled"];
      const numbers = { dormantDays: 1, indexPageLimit: 1 };
      const enums = {
        coverSize: ["small", "medium", "large"],
        theme: ["auto", "ink", "paper", "dusk"],
        viewMode: ["grid", "spine", "shelf"]
      };
      for (const key of strings) if (key in patch) data.settings[key] = String(patch[key]);
      for (const key of booleans) if (key in patch) data.settings[key] = patch[key] === true;
      for (const key of Object.keys(numbers)) {
        if (!(key in patch)) continue;
        const n = Math.floor(Number(patch[key]));
        if (Number.isFinite(n) && n >= numbers[key]) data.settings[key] = n;
      }
      for (const key of Object.keys(enums)) {
        if (key in patch && enums[key].includes(patch[key])) data.settings[key] = patch[key];
      }
      await save();
      return structuredClone(data.settings);
    }
    return {
      init,
      getData,
      getStartupNotice,
      importFile,
      importWith,
      updateDoc,
      removeDoc,
      readFileBuffer,
      markOpened,
      getOpenStats,
      setProgress,
      setCover,
      getCoverDataUrl,
      getTextIndexStatus,
      setTextIndex,
      searchTextIndex,
      addCategory,
      renameCategory,
      moveCategory,
      removeCategory,
      addTag,
      removeTag,
      addSmartShelf,
      renameSmartShelf,
      removeSmartShelf,
      updateSettings
    };
  }

  // bridge/notes-core.mjs
  function createNotes({ fs: fs2, now = () => /* @__PURE__ */ new Date() }) {
    function docDir(docId) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(String(docId || ""))) throw new Error("\u975E\u6CD5\u6587\u6863\u6807\u8BC6");
      return `notes/${docId}`;
    }
    function notePath(docId, file) {
      const name = String(file || "");
      if (!name || name !== name.trim() || /[\\/:*?"<>|]/.test(name) || name.startsWith(".")) {
        throw new Error("\u975E\u6CD5\u7B14\u8BB0\u6587\u4EF6\u540D");
      }
      return `${docDir(docId)}/${name}`;
    }
    async function list(docId) {
      const dir = docDir(docId);
      let entries;
      try {
        entries = await fs2.readdir(dir);
      } catch {
        return { notes: [] };
      }
      const notes2 = [];
      for (const ent of entries) {
        if (ent.type === "directory" || !ent.name.toLowerCase().endsWith(".md")) continue;
        let st;
        try {
          st = await fs2.stat(`${dir}/${ent.name}`);
        } catch {
          continue;
        }
        notes2.push({
          file: ent.name,
          mtime: new Date(st.mtime).toISOString(),
          birth: new Date(st.ctime ?? st.mtime).toISOString(),
          size: st.size
        });
      }
      notes2.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
      return { notes: notes2 };
    }
    async function create(docId, payload = {}) {
      const dir = docDir(docId);
      await fs2.mkdirp(dir);
      const t = now();
      const p = (n2) => String(n2).padStart(2, "0");
      const date = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
      const hm = `${p(t.getHours())}:${p(t.getMinutes())}`;
      const stamp = `${date} ${p(t.getHours())}.${p(t.getMinutes())}.${p(t.getSeconds())}`;
      let file = `${stamp}.md`;
      let n = 2;
      while (await fs2.exists(`${dir}/${file}`)) file = `${stamp} (${n++}).md`;
      const lines = [
        `# \u300A${String(payload.title || "\u672A\u547D\u540D")}\u300B\u7B14\u8BB0`,
        "",
        `- \u521B\u5EFA\uFF1A${date} ${hm}`
      ];
      const page = Math.floor(Number(payload.page));
      const total = Math.floor(Number(payload.total));
      if (page >= 1 && total >= 1) lines.push(`- \u4F4D\u7F6E\uFF1A\u7B2C ${Math.min(page, total)} / ${total} \u9875`);
      lines.push("", "");
      await fs2.writeText(notePath(docId, file), lines.join("\n"));
      return { file };
    }
    async function read(docId, file) {
      const p = notePath(docId, file);
      if (!await fs2.exists(p)) throw new Error("\u7B14\u8BB0\u6587\u4EF6\u4E0D\u5B58\u5728");
      return fs2.readFileText(p);
    }
    async function write(docId, file, text) {
      const p = notePath(docId, file);
      if (!await fs2.exists(p)) throw new Error("\u7B14\u8BB0\u6587\u4EF6\u4E0D\u5B58\u5728");
      await fs2.writeFileAtomicText(p, String(text ?? ""));
      return true;
    }
    async function trash(docId, file) {
      const p = notePath(docId, file);
      if (await fs2.exists(p)) {
        if (!await fs2.rm(p)) throw new Error("\u5220\u9664\u5931\u8D25\uFF08\u6587\u4EF6\u53EF\u80FD\u88AB\u5360\u7528\uFF09");
      }
      return true;
    }
    return { list, create, read, write, trash };
  }

  // bridge/sha256.mjs
  async function sha256Hex(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // node_modules/@capacitor/app/dist/esm/index.js
  init_dist();
  var App = registerPlugin("App", {
    web: () => Promise.resolve().then(() => (init_web2(), web_exports2)).then((m) => new m.AppWeb())
  });

  // bridge/native.mjs
  init_dist();
  var SolaceNative = registerPlugin("SolaceNative");
  async function findApps(keyword) {
    const r = await SolaceNative.findApps({ keyword: String(keyword || "") });
    return r.apps || [];
  }
  var OLIB_KEYWORDS = ["olib", "open_library", "openlibrary", "open library"];
  async function findOlibCandidates() {
    const seen = /* @__PURE__ */ new Map();
    for (const kw of OLIB_KEYWORDS) {
      try {
        for (const app of await findApps(kw)) {
          if (!seen.has(app.package)) seen.set(app.package, app);
        }
      } catch {
      }
    }
    return [...seen.values()].sort((a, b) => (b.package === "com.open_library.app") - (a.package === "com.open_library.app"));
  }
  async function launchApp(pkg) {
    const r = await SolaceNative.launchApp({ package: pkg });
    if (r && r.error) throw new Error(r.error);
    return !!r.ok;
  }
  async function pickFolder() {
    const r = await SolaceNative.pickFolder();
    if (r && !r.canceled) {
      try {
        const tail = decodeURIComponent(String(r.uri)).split("/").filter(Boolean).pop() || "";
        const name = tail.replace(/^primary:/, "").split("/").pop();
        if (name) r.name = name;
      } catch {
      }
    }
    return r;
  }
  async function listPdfs(uri) {
    const r = await SolaceNative.listPdfs({ uri });
    if (r && r.error) throw new Error(r.error);
    return r.files || [];
  }
  async function pickPdfs() {
    return SolaceNative.pickPdfs();
  }
  async function hashUri(uri) {
    const r = await SolaceNative.hashUri({ uri });
    if (r && r.error) throw new Error(r.error);
    return r;
  }
  async function copyUri(uri, destPath) {
    const r = await SolaceNative.copyUri({ uri, destPath });
    if (r && r.error) throw new Error(r.error);
    return r;
  }

  // bridge/olib-watch.mjs
  function createWatch({ lib: lib2, fs: fs2, getSettings }) {
    let callbacks = null;
    let scanSeq = 0;
    let lastScanAt = 0;
    const RESCAN_THROTTLE_MS = 15e3;
    const failed = /* @__PURE__ */ new Map();
    let notifyQueue = [];
    let notifyTimer = null;
    let state = null;
    let stateDirty = false;
    function init(cb) {
      callbacks = cb || {};
    }
    async function loadState() {
      if (state) return state;
      try {
        state = JSON.parse(await fs2.readFileText("watch-state.json"));
        if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
      } catch {
        state = {};
      }
      return state;
    }
    async function saveState() {
      if (!stateDirty) return;
      stateDirty = false;
      try {
        await fs2.writeFileAtomicText("watch-state.json", JSON.stringify(state));
      } catch {
      }
    }
    function notifyImported(doc) {
      notifyQueue.push({ id: doc.id, title: doc.title });
      clearTimeout(notifyTimer);
      notifyTimer = setTimeout(() => {
        const docs = notifyQueue;
        notifyQueue = [];
        if (docs.length && callbacks && callbacks.onImported) callbacks.onImported(docs);
      }, 800);
    }
    function reportError(message) {
      if (callbacks && callbacks.onError) callbacks.onError(message);
    }
    async function importOne(file, st) {
      try {
        const meta = await hashUri(file.uri);
        const doc = await lib2.importWith(
          { fileName: file.name, size: meta.size >= 0 ? meta.size : file.size, hash: meta.hash },
          (dest) => copyUri(file.uri, dest)
        );
        const catId = getSettings().watchCategory;
        if (catId) {
          const data = lib2.getData();
          if (data.categories.some((c) => c.id === catId)) {
            try {
              await lib2.updateDoc(doc.id, { categoryId: catId });
            } catch {
            }
          }
        }
        st[file.uri] = { size: file.size, mtime: file.mtime };
        stateDirty = true;
        notifyImported(doc);
      } catch (err) {
        if (err && err.duplicate) {
          st[file.uri] = { size: file.size, mtime: file.mtime };
          stateDirty = true;
          return;
        }
        failed.set(file.uri, file.mtime);
        reportError(`${file.name} \u5165\u5E93\u5931\u8D25\uFF08${err && err.message || err}\uFF09\uFF0C\u672C\u6B21\u8FD0\u884C\u5185\u4E0D\u518D\u91CD\u8BD5`);
      }
    }
    function shouldRun() {
      if (Date.now() - lastScanAt < RESCAN_THROTTLE_MS) return false;
      lastScanAt = Date.now();
      return true;
    }
    async function scan(opts = {}) {
      const s2 = getSettings();
      if (!s2.watchTreeUri || s2.watchEnabled === false) return;
      if (!opts.force && !shouldRun()) return;
      const gen = ++scanSeq;
      const st = await loadState();
      try {
        const files = await listPdfs(s2.watchTreeUri);
        const candidates = files.filter((f2) => {
          const seen = st[f2.uri];
          if (!seen) return true;
          return seen.size !== f2.size || seen.mtime !== f2.mtime;
        });
        if (candidates.length) {
          await new Promise((r) => setTimeout(r, 1500));
          if (gen !== scanSeq) return;
          const again = new Map((await listPdfs(s2.watchTreeUri)).map((f2) => [f2.uri, f2]));
          for (const f2 of candidates) {
            if (gen !== scanSeq) return;
            const cur = again.get(f2.uri);
            if (!cur || cur.size !== f2.size || cur.mtime !== f2.mtime) continue;
            const failedAt = failed.get(f2.uri);
            if (failedAt != null && failedAt === cur.mtime) continue;
            await importOne(f2, st);
          }
        }
        await saveState();
      } catch (err) {
        reportError(`\u81EA\u52A8\u5165\u5E93\uFF1A${err && err.message || err}\uFF08\u53EF\u5230\u8BBE\u7F6E \u2192 \u8D44\u6599\u5E93 \u91CD\u65B0\u9009\u62E9\u6587\u4EF6\u5939\uFF09`);
      }
    }
    return { init, scan };
  }

  // bridge/boot.mjs
  var randomUUID = () => {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : r & 3 | 8).toString(16);
    });
  };
  var lib = createLibrary({ fs, sha256: sha256Hex, randomUUID });
  var notes = createNotes({ fs });
  var watch = createWatch({ lib, fs, getSettings: () => lib.getData().settings || {} });
  var ready = lib.init();
  var gate = (fn) => async (...args) => {
    await ready;
    return fn(...args);
  };
  function pickPdfFiles() {
    return new Promise((resolve2) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = "application/pdf,.pdf";
      input.style.display = "none";
      document.body.appendChild(input);
      let settled = false;
      const done = (files) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve2(files);
      };
      input.addEventListener("change", () => done([...input.files]));
      const onFocus = () => {
        setTimeout(() => {
          if (!settled && (!input.files || !input.files.length)) done([]);
        }, 1200);
      };
      window.addEventListener("focus", onFocus, { once: true });
      input.click();
    });
  }
  async function importDialog() {
    const imported = [];
    const errors = [];
    const duplicates = [];
    let entries = null;
    try {
      const r = await pickPdfs();
      if (!r.canceled) entries = r.files || [];
    } catch {
    }
    const files = entries || await pickPdfFiles();
    for (const f2 of files) {
      try {
        let doc;
        if (entries) {
          const meta = await hashUri(f2.uri);
          doc = await lib.importWith(
            { fileName: f2.name, size: meta.size >= 0 ? meta.size : f2.size, hash: meta.hash },
            (dest) => copyUri(f2.uri, dest)
          );
        } else {
          const bytes = new Uint8Array(await f2.arrayBuffer());
          doc = await lib.importFile({ fileName: f2.name, size: f2.size, bytes });
        }
        imported.push(doc);
      } catch (err) {
        if (err.duplicate) duplicates.push({ file: f2.name, title: err.duplicate.title });
        else errors.push({ file: f2.name, message: String(err.message || err) });
      }
    }
    return { imported, errors, duplicates };
  }
  var solace = {
    // 平台标记：渲染层的移动端分支（打开=预览、拖拽导入禁用等）据此分流
    isMobile: true,
    // 资料库
    getLibrary: gate(() => lib.getData()),
    getOpenStats: gate(() => lib.getOpenStats()),
    importDialog: gate(importDialog),
    importPaths: gate(async () => ({ imported: [], errors: [], duplicates: [] })),
    // 触屏无拖拽导入
    getLibraryInfo: gate(async () => ({ rootDir: await rootUri() || "SolaceLibrary\uFF08\u5E94\u7528\u4E13\u5C5E\u76EE\u5F55\uFF09", canRelocate: false })),
    openLibraryRoot: gate(async () => true),
    // 平板端无文件管理器直达，占位成功
    inspectTarget: gate(async () => {
      throw new Error("\u5E73\u677F\u7AEF\u8D44\u6599\u5E93\u4F4D\u7F6E\u56FA\u5B9A\uFF0C\u4E0D\u652F\u6301\u8FC1\u79FB");
    }),
    relocateLibrary: gate(async () => {
      throw new Error("\u5E73\u677F\u7AEF\u8D44\u6599\u5E93\u4F4D\u7F6E\u56FA\u5B9A\uFF0C\u4E0D\u652F\u6301\u8FC1\u79FB");
    }),
    // 目录选择走 SAF（系统授权）：返回 { canceled, uri, name }，供监视文件夹配置
    pickDirectory: gate(async () => {
      const r = await pickFolder();
      return r && r.canceled ? null : r;
    }),
    pickFile: gate(async () => null),
    // 文档
    updateDoc: gate((id, patch) => lib.updateDoc(id, patch)),
    removeDoc: gate((id, opts) => lib.removeDoc(id, opts || {})),
    openDoc: gate(async () => {
      throw new Error("\u5E73\u677F\u7AEF\u8BF7\u7528\u5185\u7F6E\u9884\u89C8\u9605\u8BFB");
    }),
    markRead: gate((id) => lib.markOpened(id, "read")),
    readPreview: gate((id) => lib.readFileBuffer(id)),
    // 字节路径（调试/兜底）
    // 库内 PDF 的直读 URL：WebView 原生拦截 _capacitor_file_ 流式返回，
    // 内容不过 JS 桥——预览/封面/索引的加载全走这条（性能关键路径）
    getDocUrl: gate(async (id) => {
      const doc = lib.getData().documents.find((d) => d.id === id);
      if (!doc) throw new Error(`\u6587\u6863\u4E0D\u5B58\u5728: ${id}`);
      return fileUrl(`files/${doc.id}.pdf`);
    }),
    setProgress: gate((id, page, totalPages) => lib.setProgress(id, page, totalPages)),
    // 全文索引
    getTextIndexStatus: gate(() => lib.getTextIndexStatus()),
    searchTextIndex: gate((kw) => lib.searchTextIndex(kw)),
    setTextIndex: gate((id, payload) => lib.setTextIndex(id, payload)),
    // 封面
    setCover: gate((id, dataUrl) => lib.setCover(id, dataUrl)),
    getCover: gate((id) => lib.getCoverDataUrl(id)),
    // 分类
    addCategory: gate((name, parentId) => lib.addCategory(name, parentId)),
    renameCategory: gate((id, name) => lib.renameCategory(id, name)),
    moveCategory: gate((id, parentId) => lib.moveCategory(id, parentId)),
    removeCategory: gate((id) => lib.removeCategory(id)),
    // 标签
    addTag: gate((name) => lib.addTag(name)),
    removeTag: gate((id) => lib.removeTag(id)),
    // 智能收藏夹
    saveShelf: gate((name, filters) => lib.addSmartShelf(name, filters)),
    renameShelf: gate((id, name) => lib.renameSmartShelf(id, name)),
    removeShelf: gate((id) => lib.removeSmartShelf(id)),
    // 设置
    updateSettings: gate(async (patch) => {
      const s2 = await lib.updateSettings(patch);
      if ("watchEnabled" in patch || "watchTreeUri" in patch) {
        watch.scan({ force: true }).catch(() => {
        });
      }
      return s2;
    }),
    // 外部工具与自动入库（对应桌面端「打开下载器 + 监视文件夹」）
    // 平板端：拉起 Olib（包名可配置，缺省按关键字自动检测）
    launchTool: gate(async () => {
      const s2 = lib.getData().settings || {};
      let pkg = s2.externalToolPackage || "";
      if (!pkg) {
        const apps = await findOlibCandidates();
        if (apps.length === 1) pkg = apps[0].package;
        else if (apps.length > 1) throw new Error("\u68C0\u6D4B\u5230\u591A\u4E2A\u53EF\u80FD\u7684\u5E94\u7528\uFF0C\u8BF7\u5230 \u8BBE\u7F6E \u2192 \u8D44\u6599\u5E93 \u2192 \u4E0B\u8F7D\u5DE5\u5177 \u6307\u5B9A\u5305\u540D");
        else throw new Error("\u672A\u68C0\u6D4B\u5230 Olib\uFF0C\u8BF7\u5148\u5B89\u88C5\uFF1B\u6216\u5230 \u8BBE\u7F6E \u2192 \u8D44\u6599\u5E93 \u2192 \u4E0B\u8F7D\u5DE5\u5177 \u586B\u5199\u5305\u540D");
      }
      const ok = await launchApp(pkg);
      if (!ok) throw new Error(`\u65E0\u6CD5\u542F\u52A8 ${pkg}\uFF08\u5E94\u7528\u53EF\u80FD\u672A\u5B89\u88C5\uFF09`);
      return true;
    }),
    // 原生应用检索（设置面板「检测…」按钮用；Olib 检测走多关键字集合）
    findApps: gate((keyword) => keyword ? findApps(keyword) : findOlibCandidates()),
    // 自动入库事件（app.js 已监听：imported → toast+刷新；error → toast）
    onWatchEvent: (cb) => {
      watch.init({
        onImported: (docs) => cb({ type: "imported", docs }),
        onError: (message) => cb({ type: "error", message })
      });
    },
    // 笔记：列表/新建/删除与桌面端同形；打开改为交内置编辑器（inApp）
    listNotes: gate((id) => notes.list(id)),
    createNote: gate((id, payload) => notes.create(id, payload)),
    openNote: gate(async (id, file) => {
      const doc = lib.getData().documents.find((d) => d.id === id);
      const content = await notes.read(id, file);
      return { inApp: true, title: doc && doc.title || "\u7B14\u8BB0", content };
    }),
    trashNote: gate((id, file) => notes.trash(id, file)),
    revealNote: gate(async () => true),
    // 无「在文件夹中查看」，按钮已隐藏
    // 移动端内置编辑器专用：读写笔记正文
    readNote: gate((id, file) => notes.read(id, file)),
    writeNote: gate((id, file, text) => notes.write(id, file, text)),
    // 桌面端经 webUtils 转换 File 路径；平板端不提供，渲染层据此禁用拖入导入
    getStartupNotice: () => lib.getStartupNotice()
  };
  window.solace = solace;
  ready.then(() => {
    setTimeout(() => watch.scan({ force: true }).catch(() => {
    }), 3e3);
  });
  App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) watch.scan().catch(() => {
    });
  });
  App.addListener("backButton", () => {
    const dlg = document.querySelector("dialog[open]");
    if (dlg) {
      dlg.close();
      return;
    }
    const overlay = document.getElementById("previewOverlay");
    if (overlay && !overlay.hidden) {
      document.getElementById("btnPreviewClose")?.click();
      return;
    }
    const sidebar = document.querySelector(".sidebar");
    if (sidebar && sidebar.classList.contains("open")) {
      sidebar.classList.remove("open");
      const bd = document.getElementById("drawerBackdrop");
      if (bd) bd.hidden = true;
      return;
    }
    App.exitApp();
  });
  ready.then(async () => {
    const notice = lib.getStartupNotice();
    if (!notice) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (typeof window.toast === "function") {
        window.toast(notice, 8e3);
        clearInterval(timer);
      } else if (tries > 40) {
        clearInterval(timer);
      }
    }, 250);
  });
})();
