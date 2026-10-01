import test from 'node:test';
import assert from 'node:assert/strict';
import { attachQuestion } from '../src/control-plane/questions.js';
import { questionRequest } from '../src/control-plane/conversations.js';

const projects={ownerOpenIdsByProfile:{owner:['ou_admin']}};
const baseTurn=(id,messageId,content)=>({id,messageId,content,chatId:'group',profile:'owner',projectId:'p',senderId:'ou_member',createdAt:new Date().toISOString()});

test('a broad Feishu topic reply follows the newest completed descendant instead of the root question',()=>{
 const rootTurn=baseTurn('turn-root','msg-root','为什么出现异常监控');rootTurn.questionId='q-root';
 const deepTurn=baseTurn('turn-deep','msg-deep','prd环境，深度排查一下');deepTurn.questionId='q-deep';
 const follow=baseTurn('turn-follow','msg-follow','啥意思所以');
 const state={questions:{
  'q-root':{id:'q-root',rootTurnId:'turn-root',messageId:'msg-root',threadRootId:'msg-root',chatId:'group',profile:'owner',projectId:'p',senderId:'ou_member',latestTurnId:'turn-root',createdAt:rootTurn.createdAt,generation:1},
  'q-deep':{id:'q-deep',rootTurnId:'turn-deep',messageId:'msg-deep',threadRootId:'msg-root',parentQuestionId:'q-root',chatId:'group',profile:'owner',projectId:'p',senderId:'ou_member',latestTurnId:'turn-deep',createdAt:deepTurn.createdAt,generation:1},
 },conversations:[rootTurn,deepTurn,follow],jobs:[{id:'job-deep',questionId:'q-deep',status:'completed'}],cardMessages:{}};
 attachQuestion(state,follow,{reply_to:'msg-root',root_id:'msg-root'},projects);
 assert.notEqual(follow.questionId,'q-root');
 assert.equal(state.questions[follow.questionId].parentQuestionId,'q-deep');
 assert.equal(questionRequest(state,follow.questionId),'为什么出现异常监控\n\n后续补充：prd环境，深度排查一下\n\n后续补充：啥意思所以');
});

test('an explicit reply to a descendant card keeps that exact association',()=>{
 const rootTurn=baseTurn('turn-root','msg-root','原问题');rootTurn.questionId='q-root';
 const deepTurn=baseTurn('turn-deep','msg-deep','prd深查');deepTurn.questionId='q-deep';
 const follow=baseTurn('turn-follow','msg-follow','补充');
 const state={questions:{
  'q-root':{id:'q-root',rootTurnId:'turn-root',messageId:'msg-root',threadRootId:'msg-root',chatId:'group',profile:'owner',projectId:'p',senderId:'ou_member',latestTurnId:'turn-root',createdAt:rootTurn.createdAt,generation:1},
  'q-deep':{id:'q-deep',rootTurnId:'turn-deep',messageId:'msg-deep',threadRootId:'msg-root',parentQuestionId:'q-root',chatId:'group',profile:'owner',projectId:'p',senderId:'ou_member',latestTurnId:'turn-deep',createdAt:deepTurn.createdAt,generation:1},
 },conversations:[rootTurn,deepTurn],jobs:[{id:'job-deep',questionId:'q-deep',status:'completed'}],cardMessages:{'question:q-deep':{messageId:'card-deep'}}};
 attachQuestion(state,follow,{reply_to:'card-deep',root_id:'msg-root'},projects);
 assert.equal(state.questions[follow.questionId].parentQuestionId,'q-deep');
});
