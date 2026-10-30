const reads=new Set(['tables','collections','schema','select','count','group_count','aggregate','collect_values','linked_aggregate','indexes','explain_query','read_source_evidence','read_dataset','inspect_dataset','list_datasets','read_tool_result','list_tool_results','group_dataset','linked_group_dataset','period_dataset','transform_dataset','summarize_dataset','collect_dataset_values']);
export function readBatchSpec(spec){
 const available=spec.filter(s=>reads.has(s.tool)).map(s=>s.tool);
 return available.length?[{tool:'batch_read',args:{requests:'Array of {tool, arguments: object}, up to 32 independent reads with all parameters already known'},description:`同一环境的独立只读步骤可以一次规划。可选工具：${available.join(',')}。每项仍逐项权限校验/执行/记录；任一失败先停止批次、保留成功结果并重新规划，不重放成功查询。依赖前一步返回值时不能批量猜测；无整任务次数限制。`}]:[];
}
export function expandReadBatch(choice,spec){
 const value=JSON.parse(choice.arguments),items=value?.requests;
 if(!Array.isArray(items)||!items.length||items.length>32)throw new Error('batch_read.requests must contain 1..32 independent reads');
 return items.map(item=>{
  if(!reads.has(item?.tool)||!spec.some(s=>s.tool===item.tool)||!item.arguments||typeof item.arguments!=='object'||Array.isArray(item.arguments))throw new Error('batch_read contains unavailable or non-read tool/invalid arguments');
  return {tool:item.tool,arguments:JSON.stringify(item.arguments)};
 });
}
