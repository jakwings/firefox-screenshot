/*
    Firefox addon "Save Screenshot"
    Copyright (C) 2021  Manuel Reimer <manuel.reimer@gmx.de>
    Copyright (C) 2022  Jak.W <https://github.com/jakwings/firefox-screenshot>

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const browserAction = browser.browserAction;

// Fired if one of our context menu entries is clicked.
function ContextMenuClicked(aInfo) {
  SendMessage(aInfo.menuItemId);
}

// Fired if toolbar button is clicked
function ToolbarButtonClicked() {
  SendMessage('{}');
}

// Fired if shortcut is pressed
function CommandPressed(name) {
  const info = name.split('-');
  SendMessage(JSON.stringify({region: info[0], format: info[1]}));
}

// Triggers UI update (toolbar button popup and context menu)
async function UpdateUI() {
  // Get menu list
  const menus = await GetMenuList();

  //
  // Update toolbar button popup
  //

  if (menus.length)
    await browserAction.setPopup({popup: "popup/choose_format.html"});
  else
    await browserAction.setPopup({popup: ""});

  //
  // Update context menu
  //

  await browser.contextMenus.removeAll();

  const prefs = await Storage.get();

  if (prefs.show_contextmenu) {
    const topmenu = browser.contextMenus.create({
      id: '{}',
      title: T$('extensionName'),
      contexts: ['page'],
    });

    menus.forEach((entry) => {
      browser.contextMenus.create({
        id: entry.data,
        title: entry.label,
        contexts: ["page"],
        parentId: topmenu
      });
    });
  }
}

// Register event listener to receive option update notifications and
// content script requests
browser.runtime.onMessage.addListener((data, sender) => {
  // An option change with request for redraw happened
  if (data.type === 'OptionsChanged' && data.redraw) return UpdateUI();

  // The content script requests us to take a screenshot
  if (data.type === 'TakeScreenshot') return TakeScreenshot(data, sender.tab);
});


async function TakeScreenshot(req, tab) {
  // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Browser_support_for_JavaScript_APIs
  const BROWSER_VERSION_MAJOR = parseInt((await browser.runtime.getBrowserInfo()).version, 10);
  const badge = ['setTitle', 'setBadgeText', 'setBadgeBackgroundColor'].every(x => {
    return x in browserAction;
  });

  const mutex = new Mutex({lock_time: 1000 * 60 * 5});
  const key = 'browserAction-' + tab.id;
  const nid = Date.now();

  let restoreScrollPosition = () => Promise.resolve();
  try {
    if (!(await mutex.lock(key, {retry: false}))) {
      return;
    }
    await browserAction.disable(tab.id);

    // Maximum size is limited!
    // https://developer.mozilla.org/en-US/docs/Web/HTML/Element/canvas#maximum_canvas_size
    // https://hg.mozilla.org/mozilla-central/file/93c7ed3f5606865707e5ebee8709b13ce0c2e220/dom/canvas/CanvasRenderingContext2D.cpp#l4814
    // https://hg.mozilla.org/mozilla-central/file/93c7ed3f5606865707e5ebee8709b13ce0c2e220/gfx/2d/Factory.cpp#l326
    // WTF: animation sucks your eyeballs out during multiple screen captures
    const {vw, vh, pw, ph, width: rw, height: rh} = req;
    const {scroll: {sx, sy, spx, spy}, direction: dir} = req;
    const scl = BROWSER_VERSION_MAJOR >= 82 ? req.scale : 1;
    const limits = [32767 / scl, 472907776 / (scl * scl)].map(Math.trunc);
    const one_canvas = Math.max(rw, rh) <= limits[0] && rw * rh <= limits[1];

    const prefs = await Storage.get();
    const format = {
      png: ['png', 'png', 'image/png'],
      jpg: ['jpg', 'jpeg', 'image/jpeg'],
      copy: ['png', 'png', 'image/png'],
    }[req.format];
    const quality = prefs.jpegquality;

    const filename = GetDefaultFileName('saved_page', tab, prefs.filenameformat) + '.' + format[0];

    const [totalWidth, totalHeight] = [rw, rh].map(x => Math.trunc(x * scl));
    let content = null;
    if (one_canvas) {
      let canvas = document.createElement('canvas');
      content = canvas.getContext('2d', {alpha: false});
      canvas.width = totalWidth;
      canvas.height = totalHeight;
    } else {
      try {
        let size = totalWidth * totalHeight * 4;
        if (size < Number.MAX_SAFE_INTEGER) {
          // RangeError: invalid array length ?
          // TODO: new ImageWriter('tiff'); URL.createObjectURL(new Blob([...tiff_strips]))
          content = new Uint8Array(size);
        } else {
          throw null;
        }
      } catch (err) {
        alarm(T$('errorImageTooLarge', filename), {id: nid});
        return;
      }
      notify(T$('warningImageVeryLarge'), {id: nid});
    }

    const use_native = (BROWSER_VERSION_MAJOR >= 82
                        || (scl == 1 && CanvasRenderingContext2D.prototype.drawWindow));
    const use_css_croll = !use_native;
    const use_js_scroll = !use_native && !use_css_croll;

    console.info({one_canvas, use_native, use_css_croll, use_js_scroll, BROWSER_VERSION_MAJOR});

    // XXX: scrolling can cause side effects
    let use_scroll = use_css_croll || use_js_scroll;
    let updateScrollPosition = null;

    const js_scroll_restore = `window.scrollTo(${sx + spx}, ${sy + spy})`;
    const css_reset = {
      allFrames: true,
      runAt: 'document_start',
      cssOrigin: 'user',
      code: `
        :root { min-width: 100vw !important; min-height: 100vh !important; }
        *, *>*, *>*>* { animation-play-state: paused !important; }
      `,
    };
    let resetScrollPosition = () => {
      // TODO: stop js and svg animation
      return browser.tabs.insertCSS(tab.id, css_reset).then(() => {
        // reset position of sticky elements
        return browser.tabs.executeScript(tab.id, {
          runAt: 'document_start',
          code: 'window.scrollTo(0, 0)',
        });
      });
    };

    if (use_css_croll) {
      let tasks = [() => browser.tabs.removeCSS(tab.id, css_reset)];
      restoreScrollPosition = () => {
        restoreScrollPosition = () => Promise.resolve();
        return Promise.all(tasks.map(exec => exec())).then(() => {
          return browser.tabs.executeScript(tab.id, {
            runAt: 'document_start',
            code: js_scroll_restore,
          });
        });
      };
      // https://developer.mozilla.org/en-US/docs/Web/CSS/Cascade
      let applyCssScroll = null;
      // XXX: stuttering of background when scrollbar disappear?
      //      setting min-width/height doesn't seem to work
      let style = (await browser.tabs.executeScript(tab.id, {
        runAt: 'document_start',
        code: `{
          let style = window.getComputedStyle(document.documentElement);
          ({
            translate: style.translate,
            transform: style.transform,
            bgx: style.backgroundPositionX,
            bgy: style.backgroundPositionY,
          })
        }`,
      }))[0];
      style.bgx = style.bgx.split(/\s*,\s*/);
      style.bgy = style.bgy.split(/\s*,\s*/);
      if (style.translate != null) {
        let xyz = (style.translate.replace(/^none$/, '') + ' 0px 0px 0px').trim().split(/\s+/);
        applyCssScroll = (x, y) => {
          let bgx = style.bgx.map(v => `calc(${v} - ${x}px)`).join(', ');
          let bgy = style.bgy.map(v => `calc(${v} - ${y}px)`).join(', ');
          let css = {
            runAt: 'document_start',
            cssOrigin: 'user',
            code: `
              :root {
                translate: calc(${xyz[0]} - ${x}px) calc(${xyz[1]} - ${y}px)
                           ${xyz[2]} !important;
                transition: none !important;
                background-position-x: ${bgx} !important;
                background-position-y: ${bgy} !important;
              }
            `,
          };
          return browser.tabs.insertCSS(tab.id, css).then(() => {
            tasks.push(() => browser.tabs.removeCSS(tab.id, css));
          });
        };
      } else {
        let toCSS = (x, y) => {
          if (/\bmatrix(?:3d)?\b/.test(style.transform)) {
            return style.transform.replace(
              /\b(matrix(?:3d)?)\s*\(([^)]*)\)/,
              (_, func, args) => {
                let xyz = args.split(/\s*,\s*/);
                switch (func) {
                  case 'matrix':
                    xyz[4] = `calc(${xyz[4]} - ${x}px)`;
                    xyz[5] = `calc(${xyz[5]} - ${y}px)`;
                    break;
                  case 'matrix3d':
                    xyz[12] = `calc(${xyz[12]} - ${x}px)`;
                    xyz[13] = `calc(${xyz[13]} - ${y}px)`;
                    break;
                  default: throw new Error('toCSS');
                }
                return `${func}(${xyz.join(', ')})`;
              }
            );
          } else {
            return style.transform.replace(/^none$/, '') + ` translate(-${x}px, -${y}px)`;
          }
        };
        applyCssScroll = (x, y) => {
          let bgx = style.bgx.map(v => `calc(${v} - ${x}px)`).join(', ');
          let bgy = style.bgy.map(v => `calc(${v} - ${y}px)`).join(', ');
          let css = {
            runAt: 'document_start',
            cssOrigin: 'user',
            code: `
              :root {
                transform: ${toCSS(x, y)} !important;
                transition: none !important;
                background-position-x: ${bgx} !important;
                background-position-y: ${bgy} !important;
              }
            `,
          };
          return browser.tabs.insertCSS(tab.id, css).then(() => {
            tasks.push(() => browser.tabs.removeCSS(tab.id, css));
          });
        };
      }
      let is_first = true;  // (sx, sy) is static, useless after scrolling
      updateScrollPosition = async (x, y, w, h) => {
        // _s[xy] is not clamped when exceeding scrollMax[XY]
        let _sx = dir.x > 0 ? x : -(pw - x) + w;
        let _sy = dir.y > 0 ? y : -(ph - y) + h;
        if (is_first) {
          is_first = false;
          let no_scroll_x = dir.x > 0 ? (_sx >= sx && _sx + w <= sx + vw)
                                      : (_sx <= sx && _sx - w >= sx - vw);
          let no_scroll_y = dir.y > 0 ? (_sy >= sy && _sy + h <= sy + vh)
                                      : (_sy <= sy && _sy - h >= sy - vh);
          if (no_scroll_x && no_scroll_y) {
            return {
              x: dir.x > 0 ? _sx - sx : vw - (sx - _sx + w),
              y: dir.y > 0 ? _sy - sy : vh - (sy - _sy + h),
            };
          }
          await resetScrollPosition();
        }
        await applyCssScroll(_sx, _sy);
        return {
          x: dir.x > 0 ? 0 : vw - w,
          y: dir.y > 0 ? 0 : vh - h,
        };
      };
    } else if (use_js_scroll) {
      restoreScrollPosition = () => {
        restoreScrollPosition = () => Promise.resolve();
        return browser.tabs.executeScript(tab.id, {
          runAt: 'document_start',
          code: js_scroll_restore,
        });
      };
      let is_first = true;  // (sx, sy) is static, useless after scrolling
      updateScrollPosition = async (x, y, w, h) => {
        // _s[xy] is not clamped when exceeding scrollMax[XY]
        let _sx = dir.x > 0 ? x : -(pw - x) + w;
        let _sy = dir.y > 0 ? y : -(ph - y) + h;
        if (is_first) {
          is_first = false;
          let no_scroll_x = dir.x > 0 ? (_sx >= sx && _sx + w <= sx + vw)
                                      : (_sx <= sx && _sx - w >= sx - vw);
          let no_scroll_y = dir.y > 0 ? (_sy >= sy && _sy + h <= sy + vh)
                                      : (_sy <= sy && _sy - h >= sy - vh);
          if (no_scroll_x && no_scroll_y) {
            return {
              x: dir.x > 0 ? _sx - sx : vw - (sx - _sx + w),
              y: dir.y > 0 ? _sy - sy : vh - (sy - _sy + h),
            };
          }
        }
        await resetScrollPosition();
        return {
          // full page ?
          x: x <= pw - vw ? 0 : vw - w,
          y: y <= ph - vh ? 0 : vh - h,
        };
      };
    }

    if (req.region === 'full' && !use_css_croll) {
      if (!use_scroll && use_native) {
        use_scroll = true;
        restoreScrollPosition = () => {
          restoreScrollPosition = () => Promise.resolve();
          return browser.tabs.removeCSS(tab.id, css_reset).then(() => {
            return browser.tabs.executeScript(tab.id, {
              runAt: 'document_start',
              code: js_scroll_restore,
            });
          });
        };
      }
      await resetScrollPosition();
    }

    const [mw, mh] = (() => {
      // XXX: browser.tab.captureTab and DrawWindow:
      //      glitches happen on large capture area
      //      happens when scl != window.devicePixelRatio ?
      //      test page: https://en.wikipedia.org/wiki/Firefox
      if (use_native) {
        if (false && BROWSER_VERSION_MAJOR >= 82 && scl == window.devicePixelRatio) {
          return [rw, rh].map(x => Math.min(x, limits[0]));
        } else {
          return [Math.min(rw, limits[0], 4095), Math.min(rh, limits[0], 16383)];
        }
      } else {
        return [Math.min(vw, limits[0], 4095), Math.min(vh, limits[0], 16383)];
      }
    })();

    if (badge) {
      await browserAction.setTitle({title: T$('badge_capturing'), tabId: tab.id});
      await browserAction.setBadgeBackgroundColor({color: 'red', tabId: tab.id});
    }
    const jobs = new JobQueue();
    const decoding = new JobQueue();
    let count = Math.ceil(rw / mw) * Math.ceil(rh / mh);

    for (let y = 0; y < rh; y += mh) {
      let h = (y + mh <= rh ? mh : rh - y);
      for (let x = 0; x < rw; x += mw) {
        let w = (x + mw <= rw ? mw : rw - x);
        let left = req.left + x;
        let top = req.top + y;
        if (badge) {
          jobs.push(() => {
            // no waiting since capturing is in serial order; unimportant text
            browserAction.setBadgeText({text: String(count--), tabId: tab.id});
          });
        }
        let pos = null, img = new Image();
        if (use_native) {
          let _sx = dir.x > 0 ? left : Math.min(-(pw - left) + vw, vw - w);
          let _sy = dir.y > 0 ? top : Math.min(-(ph - top) + vh, vh - h);
          pos = {x: 0, y: 0};
          if (BROWSER_VERSION_MAJOR >= 82) {
            let opts = {
              format: format[1],
              quality: one_canvas ? quality : 100,
              rect: {x: _sx, y: _sy, width: w, height: h},
              scale: scl,
            };
            jobs.push(() => browser.tabs.captureTab(tab.id, opts));
          } else {
            // doesn't seem to support high dpi
            let opts = {
              type: 'DrawWindow',
              format: format[2],
              quality: one_canvas ? quality : 100,
              rect: {x: _sx, y: _sy, width: w, height: h},
            };
            jobs.push(() => browser.tabs.sendMessage(tab.id, opts));
          }
        } else {
          let args = [left, top, w, h];
          jobs.push(async () => pos = await updateScrollPosition(...args));
          if (BROWSER_VERSION_MAJOR >= 59) {
            jobs.push(() => browser.tabs.captureTab(tab.id, {
              format: format[1],
              quality: one_canvas ? quality : 100,
            }));
          } else {
            jobs.push(() => browser.tabs.captureVisibleTab(tab.windowId, {
              format: format[1],
              quality: one_canvas ? quality : 100,
            }));
          }
        }
        let args = [x, y, w, h];
        jobs.push(url => {
          decoding.push(() => {
            img._decoded = img.decode ? {
              then: (func) => img.decode().then(func),
            } : new Promise((resolve, reject) => {
              img.onload = function OnLoad$() {
                return img.complete ? resolve() : setTimeout(OnLoad$, 0);
              };
              img.onerror = reject;
            });
            img.src = url;
            return img._decoded.then(() => {
              let [x, y, w, h] = args;
              if (one_canvas) {
                content.drawImage(img, pos.x * scl, pos.y * scl, w * scl, h * scl,
                                           x * scl,     y * scl, w * scl, h * scl);
                //DebugDraw(ctx, {x, y, w, h, scl});
              } else {
                let canvas = document.createElement('canvas');
                let ctx = canvas.getContext('2d', {alpha: false});
                canvas.width = Math.trunc(w * scl);
                canvas.height = Math.trunc(h * scl);
                ctx.drawImage(img, pos.x * scl, pos.y * scl, w * scl, h * scl,
                                             0,           0, w * scl, h * scl);
                //DebugDraw(ctx, {x:0, y:0, w, h, scl});
                if (x == 0 && w == rw) {
                  content.set(ctx.getImageData(0, 0, w * scl, h * scl).data,
                              y * rw * scl * 4);
                } else {
                  for (let i = 0; i < h * scl; i++) {
                    content.set(ctx.getImageData(0, i, w * scl, 1).data,
                                ((y + i) * rw * scl + x) * 4);
                  }
                }
              }
            });
          });
        });
      }
    }
    await jobs.serial().then(restoreScrollPosition);

    if (badge) {
      await browserAction.setTitle({title: T$('badge_saving'), tabId: tab.id});
      await browserAction.setBadgeText({text: '...', tabId: tab.id});
      await browserAction.setBadgeBackgroundColor({color: 'green', tabId: tab.id});
    }
    await browserAction.enable(tab.id);
    mutex.unlock(key);

    await decoding.parallel();
    if (one_canvas) {
      content = await (await fetch(content.canvas.toDataURL())).arrayBuffer();
    } else {
      const lock_time = 1000 * 60 * 15;
      // worker is often cpu hog, just one is enough
      if (!(await mutex.lock('worker', {retry: false, lock_time}))) {
        notify(T$('warningWorkerBusy'), {id: nid});
        await mutex.lock('worker', {lock_time});
        if (badge) {
          await browserAction.setTitle({title: T$('badge_saving'), tabId: tab.id});
          await browserAction.setBadgeText({text: '...', tabId: tab.id});
          await browserAction.setBadgeBackgroundColor({color: 'green', tabId: tab.id});
        }
      }
//console.time('worker');
      // TODO: optional wasm support
      let worker = new Worker(
        format[1] === 'jpeg' ? 'lib/worker-jpeg.js' : 'lib/worker-png.js'
      );
      // use worker to avoid blocking other extensions
      content = await new Promise((resolve, reject) => {
        worker.onerror = (event) => reject(event);
        worker.onmessage = (event) => resolve(event.data);
        worker.postMessage({
          data: content,
          width: totalWidth,
          height: totalHeight,
          quality: quality,
        });
        setTimeout(reject, lock_time, 'timeout');
      }).catch(err => {
        abort(err);
      }).finally(() => {
        worker.terminate();
        mutex.unlock('worker');
      });
//console.timeEnd('worker');
    }

    // Handle copy to clipboard
    if (req.format === 'copy') {
      await browser.clipboard.setImageData(content, format[1]);
      if (prefs.copynotification) {
        notify(T$('info_screenshot_copied'), {id: nid});
      }
    }

    // All other data formats have to be handled as downloads
    else {
      // Add image comment if we are allowed to
      if (prefs.image_comment) {
        content = await ApplyImageComment(content, tab.title, tab.url);
      }

      // The method "open" requires a temporary <a> hyperlink whose creation and
      // handling has to be offloaded to our content script
      if (prefs.savemethod === 'open') {
        await browser.tabs.sendMessage(tab.id, {
          type: 'TriggerOpen',
          content: new Blob([content], {type: format[2]}),
          filename: filename,
        });
      }
      // All other download types are handled with the "browser.downloads" API
      else {
        let url = URL.createObjectURL(new Blob([content], {type: format[2]}));
        let options = {
          filename: prefs.targetdir ? prefs.targetdir + '/' + filename: filename,
          url: url,
          saveAs: (prefs.savemethod === 'saveas')
        };

        const downloads = new Map();
        downloads.promise = new Promise((resolve, reject) => {
          downloads.resolve = resolve;
          downloads.reject = reject;
        });
        const OnDownload$ = (delta) => {
          if (delta.state && downloads.has(delta.id)) {
            if (delta.state.current === 'complete') {
              URL.revokeObjectURL(downloads.get(delta.id).url);
              downloads.delete(delta.id);
              if (downloads.size === 0) {
                downloads.resolve();
              }
            } else if (delta.state.current === 'interrupted') {
              URL.revokeObjectURL(downloads.get(delta.id).url);
              downloads.reject();
            }
          }
        };
        // Download change listener.
        // Used to create a notification in the "non prompting" mode, so the user knows
        // that his screenshot has been created. Also handles cleanup after download.
        browser.downloads.onChanged.addListener(OnDownload$);

        try {
          // Trigger download
          let download_id = await browser.downloads.download(options);

          // Store download options for usage in "onChanged".
          downloads.set(download_id, options);
          await downloads.promise;

          // When saving without prompting, then trigger notification
          const prefs = await Storage.get();
          if (!options.saveAs && prefs.savenotification) {
            notify(T$('info_screenshot_saved') + '\n' + options.filename, {id: nid});
          }
        } catch (err) {
          abort(err);
        } finally {
          // Free memory used for our "blob URL"
          URL.revokeObjectURL(options.url);
          browser.downloads.onChanged.removeListener(OnDownload$);
        }
      }
    }
  } catch (err) {
    console.error(err);
    alarm(`Failed to generate ${filename}\nReason: ${err}`, {id: nid});
    restoreScrollPosition().catch(ignore);
  } finally {
    if (await mutex.lock(key, {retry: false})) {
      if (badge) {
        await browserAction.setTitle({title: '', tabId: tab.id});
        await browserAction.setBadgeText({text: '', tabId: tab.id});
        try {
          await browserAction.setBadgeBackgroundColor({color: null, tabId: tab.id});
        } catch (err) {
          await browserAction.setBadgeBackgroundColor({color: '', tabId: tab.id});
        }
      }
      await browserAction.enable(tab.id);
      mutex.unlock(key);
    }
    mutex.unlock('worker');
  }
}
function DebugDraw(ctx, i) {
  ctx._ = (ctx._ || 0) + 1;
  ctx.save();
  ctx.scale(i.scl, i.scl);
  ctx.fillStyle = ['rgba(255,0,0,0.1)', 'rgba(0,255,0,0.1)', 'rgba(0,0,255,0.1)'][ctx._ % 3];
  ctx.font = `${50 * i.scl}px sans-serif`;
  ctx.textBaseline = 'top';
  ctx.strokeStyle = '#000';
  ctx.setLineDash([5, 5]);
  ctx.lineWidth = 1;
  ctx.fillRect(i.x, i.y, i.w, i.h);
  ctx.strokeRect(i.x, i.y, i.w, i.h);
  ctx.setLineDash([]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fff';
  ctx.strokeText(ctx._, i.x, i.y, i.w);
  ctx.fillStyle = '#000';
  ctx.fillText(ctx._, i.x, i.y, i.w);
  ctx.restore();
}


// Gets the default file name, used for saving the screenshot
function GetDefaultFileName(aDefaultFileName, tab, aFilenameFormat) {
  //prioritize formatted variant
  const formatted = SanitizeFileName(ApplyFilenameFormat(aFilenameFormat, tab));
  if (formatted)
    return formatted;

  // If possible, base the file name on document title
  const title = SanitizeFileName(tab.title);
  if (title)
    return title;

  // Otherwise try to use the actual HTML filename
  const url = new URL(tab.url)
  const path = url.pathname;
  if (path) {
    const filename = SanitizeFileName(path.substring(path.lastIndexOf('/')+1));
    if (filename)
      return filename;
  }

  // Finally use the provided default name
  return aDefaultFileName;
}

// Replaces format character sequences with the actual values
function ApplyFilenameFormat(aFormat, tab) {
  const now = new Date();
  aFormat = aFormat.replace(/%Y/,now.getFullYear());
  aFormat = aFormat.replace(/%m/,(now.getMonth()+1).toString().padStart(2, '0'));
  aFormat = aFormat.replace(/%d/,now.getDate().toString().padStart(2, '0'));
  aFormat = aFormat.replace(/%H/,now.getHours().toString().padStart(2, '0'));
  aFormat = aFormat.replace(/%M/,now.getMinutes().toString().padStart(2, '0'));
  aFormat = aFormat.replace(/%S/,now.getSeconds().toString().padStart(2, '0'));
  aFormat = aFormat.replace(/%t/,tab.title || "");
  aFormat = aFormat.replace(/%u/,tab.url.replace(/:/g, ".").replace(/[\/\?]/g, "-"));
  aFormat = aFormat.replace(/%h/,(new URL(tab.url)).hostname);
  return aFormat;
}

// "Sanitizes" given string to be used as file name.
function SanitizeFileName(aFileName) {
  // http://www.mtu.edu/umc/services/digital/writing/characters-avoid/
  aFileName = aFileName.replace(/[<\{]+/g, "(");
  aFileName = aFileName.replace(/[>\}]+/g, ")");
  aFileName = aFileName.replace(/[#$%!&*\'?\"\/:\\@|]/g, "");
  // Remove leading spaces, "." and "-"
  aFileName = aFileName.replace(/^[\s-.]+/, "");
  // Remove trailing spaces and "."
  aFileName = aFileName.replace(/[\s.]+$/, "");
  // Replace all groups of spaces with just one space character
  aFileName = aFileName.replace(/\s+/g, " ");
  return aFileName;
}


// Migrates old "only one possible" preferences to new "multi select" model
async function MigrateSettings() {
  const prefs = await Storage.get();
  const newprefs = {};
  if ("region" in prefs) {
    if (prefs.region == "manual")
      newprefs.regions = ["full", "viewport", "selection"];
    else
      newprefs.regions = [prefs.region];
    await Storage.remove("region");
  }
  if ("format" in prefs) {
    if (prefs.format == "manual")
      newprefs.formats = ["png", "jpg", "copy"];
    else
      newprefs.formats = [prefs.format];
    await Storage.remove("format");
  }
  await Storage.set(newprefs);
}

async function Startup() {
  await MigrateSettings();
  await UpdateUI();
}

// Register event listeners
browser.contextMenus.onClicked.addListener(ContextMenuClicked);
browser.browserAction.onClicked.addListener(ToolbarButtonClicked);
browser.commands.onCommand.addListener(CommandPressed);

Startup();
