// Display only measured stages and counts. A directory scan has no known time percentage.
export function contactProgressText(turn, now = Date.now()) {
  const p = turn.contactProgress;
  if (!p) return '正在查询获准的通讯录并准备联系人信息图；较大范围首次查询可能需要一些时间。';
  const count = key => Number.isSafeInteger(p[key]) && p[key] >= 0 ? p[key] : 0;
  const stages = {
    authorizing: '正在核对通讯录读取范围和权限。',
    directory_tree: `正在读取部门目录，已发现 ${count('totalDepartments')} 个部门。`,
    directory_members: `正在刷新目录索引：已读完 ${count('completedDepartments')} / ${count('totalDepartments')} 个部门，汇总 ${count('memberCount')} 条成员记录，已读取 ${count('pagesRead')} 页。`,
    direct_members: `正在读取授权成员：已核对 ${count('completedPeople')} / ${count('totalPeople')} 位，汇总 ${count('memberCount')} 条成员记录。`,
    directory_ready: `目录读取完成，已取得 ${count('memberCount')} 位可用成员。`,
    index_hit: `已复用本机目录索引（${count('memberCount')} 位成员），仍会实时核实目标人员。`,
    matching: '正在按姓名或完整工号匹配人员。',
    candidates: '存在多位匹配人员，正在核实候选资料。',
    person: '正在读取目标人员的最新资料。',
    organization: '正在核对岗位、部门父级路径与直属上级。',
    rendering: '正在生成联系人信息图。',
    image_ready: '联系人信息图已生成，准备复核并投递私有结果。',
    validating: '正在复核图片、资料和读取范围。',
    uploading: '正在上传私有结果图片。',
    delivering: '正在向提问者和群主投递私有结果。',
  };
  const text = stages[p.stage] ?? '正在查询获准的通讯录。';
  const age = Math.max(0, Math.floor((now - Date.parse(p.updatedAt)) / 1000));
  return text + (Number.isFinite(age) ? `\n阶段最近推进：${age} 秒前；处理尚未结束。` : '');
}
