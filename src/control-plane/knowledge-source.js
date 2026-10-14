import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
const execute=promisify(execFile);
const hash=x=>createHash('sha256').update(x).digest('hex');
const within=(root,target)=>{const r=path.relative(root,target);return r===''||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
export class KnowledgeSource {
  constructor({now=Date.now,head}={}){this.now=now;this.head=head;this.cache=new Map();this.pending=new Map();}
  async git(cwd,args){
    const {stdout}=await execute('git',['-c',`core.hooksPath=${os.devNull}`,'-c','submodule.recurse=false','-C',cwd,...args],{
      timeout:10000,maxBuffer:128*1024,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}});
    return stdout.trim();
  }
  repositories(project,environment){return project.analysisSourceMode==='isolated'?project.analysisEnvironments?.[environment]?.repositories:project.analysisRepositories;}
  async origin(project,repository,environment){
    const configured=this.repositories(project,environment)?.find(r=>r.path===repository);
    if(!configured?.branch||path.isAbsolute(repository)||repository.split(/[\\/]/).includes('..'))throw new Error('Unknown environment repository');
    const root=await realpath(project.repoPath),cwd=await realpath(path.resolve(root,repository));
    if(!within(root,cwd)||await realpath(await this.git(cwd,['rev-parse','--show-toplevel']))!==cwd)throw new Error('Unsafe environment repository');
    await this.git(cwd,['check-ref-format',`refs/heads/${configured.branch}`]);
    const origin=await this.git(cwd,['remote','get-url','origin']);
    return {cwd,branch:configured.branch,originHash:hash(origin)};
  }
  async bindings(project,environment,report,dependencies){
    const result=[];
    for(const repository of [...new Set(dependencies.map(d=>d.repository))]){
      const proof=report.repositories.find(r=>r.path===repository);
      if(!proof||!/^[a-f0-9]{40,64}$/.test(proof.commit??''))throw new Error('Missing source commit proof');
      const current=await this.origin(project,repository,environment);
      if(current.branch!==proof.branch)throw new Error('Source environment changed');
      result.push({repository,branch:proof.branch,commit:proof.commit,originHash:current.originHash});
    }
    return result;
  }
  async current(project,environment,binding){
    if(this.head)return this.head(project,environment,binding);
    const origin=await this.origin(project,binding.repository,environment);
    if(origin.branch!==binding.branch||origin.originHash!==binding.originHash)return {same:false,reason:'source_scope_changed'};
    const key=JSON.stringify([origin.cwd,origin.branch,origin.originHash]);
    const cached=this.cache.get(key);if(cached&&this.now()-cached.at<30000)return {same:cached.commit===binding.commit,reason:'environment_branch_changed'};
    if(!this.pending.has(key))this.pending.set(key,(async()=>{
      const value=await this.git(origin.cwd,['ls-remote','--exit-code','origin',`refs/heads/${origin.branch}`]);
      const lines=value.split(/\r?\n/).filter(Boolean),parts=lines[0]?.split(/\s+/);
      if(lines.length!==1||!/^([a-f0-9]{40,64})$/.test(parts?.[0]??'')||parts[1]!==`refs/heads/${origin.branch}`)throw new Error('Cannot verify environment branch');
      if(this.cache.size>=128)this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key,{at:this.now(),commit:parts[0]});return parts[0];
    })().finally(()=>this.pending.delete(key)));
    const commit=await this.pending.get(key);return {same:commit===binding.commit,reason:'environment_branch_changed'};
  }
}
