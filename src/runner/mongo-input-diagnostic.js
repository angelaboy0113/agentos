import policy from './ssh-mongo-worker.cjs';
// Fixed diagnostics only: do not echo values, arbitrary keys, filters or remote
// error bodies. Identify the failing argument index before another model round.
export function mongoInputDiagnostic(args,code){
 if(code==='MONGO_VALUE_TYPE'||code==='MONGO_FILTERS'){
  for(const [i,f]of (Array.isArray(args?.filters)?args.filters:[]).entries())try{policy.filters([f]);}catch{
   return `filters[${i}]参数不正确：字段使用column、运算符使用=/>/>=/</<=/in；string值为文本，boolean为JSON布尔值，int64/decimal为十进制文本，date为有效ISO时间且带明确时区。in的value必须为非空数组，不能传原始Mongo表达式。仅修正该项，已有结果继续复用。`;
  }
  return 'filters须为结构化数组；每项只用column/op/type/value，空值使用is_null/is_missing，不能混用SQL运算符eq/gte或原始Mongo表达式。';
 }
 if(code==='MONGO_ARGUMENTS')return 'Mongo参数层级不正确：仅collections、columns、filters、groupColumns、aggregates；cohort由本机受控适配器解析，不能传table、pipeline、sort、limit或任意命令。按当前工具目录修正本项。';
 if(code==='MONGO_FIELDS')return '读取完整原始记录使用非空columns数组，列名须来自实际schema；不能重复或包含敏感字段。聚合读取另用groupColumns和非空aggregates。';
 if(code==='MONGO_DISTINCT_COMBINATION')return 'Mongo count_distinct须单独一个聚合指标；多个独立指标可batch_read，多个时间窗口可保存完整来源后window_dataset一次计算。';
 return 'Mongo聚合参数不正确：groupColumns为实际分组列数组（全局汇总用[]），aggregates为非空数组；每项明确op、唯一as，count之外还需真实column。原始明细读取用columns，不同时传空aggregates。';
}
