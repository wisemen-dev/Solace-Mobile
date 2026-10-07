// 书脊分组钩子：把纯函数挂到 window.__spineGroups，供 app.js 的移动补丁
// （renderSpineShelves 内）调用。index.html 里 mobile.js 模块先于 app.js
// 执行，钩子注册必然就位；缺席属异常时序，app 侧补丁退化为空陈列
// （显式暴露问题，优于按桌面口径静默错排）。
import { groupSpines } from './spine-group.mjs'

window.__spineGroups = groupSpines
