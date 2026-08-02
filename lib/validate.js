// 闲不住 — 输入校验公共模块
// 单一事实源：接口参数校验、伙伴扫描过滤共用同一份规则
// 规则设计：
//  - 允许合法 Unicode 字符（含中文 ID），不限定 ASCII 子集
//  - 拒绝路径分隔符 / \\ 与控制字符，堵死路径穿越
//  - 拒绝 . / .. 与原型链特殊键，防相对路径逃逸与对象原型污染

export function isValidAgentId(id) {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 100 &&
    !/[/\\\x00-\x1f\x7f]/.test(id) &&
    id !== "." &&
    id !== ".." &&
    !["__proto__", "constructor", "prototype"].includes(id)
  );
}
