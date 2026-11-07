// Notes for the site owner only. The NOTIFY binding is locked by Email Routing to the owner's
// verified address, so these messages can never reach anyone else.
import {escapeHtml,formatBytes,now,optional} from './util';

// NOTIFY_FROM is an address on the deployment's own email domain; vidcapture.stream uses the default.

function page(heading:string,rows:[string,string][],link:{href:string;label:string}){
 const cells=rows.map(([k,v])=>`<tr><td style="padding:6px 16px 6px 0;color:#73786e;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 0">${escapeHtml(v)}</td></tr>`).join('');
 return `<!doctype html><html><body style="margin:0;background:#f6f5f1;font-family:Inter,Segoe UI,Arial,sans-serif;color:#242823"><div style="max-width:560px;margin:0 auto;padding:36px 24px"><p style="font-size:18px;font-weight:600;margin:0 0 16px">${escapeHtml(heading)}</p><table style="font-size:15px;line-height:1.5;border-collapse:collapse;margin:0 0 24px">${cells}</table><a href="${escapeHtml(link.href)}" style="display:inline-block;background:#375b43;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px">${escapeHtml(link.label)}</a></div></body></html>`;
}
async function send(env:Env,subject:string,heading:string,rows:[string,string][],link:{href:string;label:string}){
 const text=`${heading}\n\n${rows.map(([k,v])=>`${k}: ${v}`).join('\n')}\n\n${link.label}: ${link.href}\n`;
 const {NOTIFY,NOTIFY_TO,NOTIFY_FROM}=optional(env);
 if(!NOTIFY||!NOTIFY_TO){console.log(JSON.stringify({event:'notify-skipped',subject,reason:'not configured'}));return false;}
 try{await NOTIFY.send({from:{email:NOTIFY_FROM||'reports@vidcapture.stream',name:'VidCapture'},to:NOTIFY_TO,subject,text,html:page(heading,rows,link)});return true;}
 catch(error){console.error(JSON.stringify({event:'notify-failed',subject,error:error instanceof Error?error.message:'Unknown error'}));return false;}
}

// One email per reported video every six hours, and at most 20 an hour overall, so a flood of
// reports cannot flood the inbox. Every report still appears on /admin.
export async function reportFiled(env:Env,video:{id:string;title:string;share_id:string},reason:string,details:string|null,owner:string|null){
 const recent=await env.DB.prepare("SELECT (SELECT COUNT(*) FROM reports WHERE video_id=? AND created_at>?) AS same,(SELECT COUNT(*) FROM reports WHERE created_at>?) AS total").bind(video.id,now()-6*3600,now()-3600).first<{same:number;total:number}>();
 if((recent?.same||0)>1||(recent?.total||0)>20)return false;
 return send(env,`Video reported: ${video.title.slice(0,80)}`,'A viewer reported a video',[['Video',video.title],['Reason',reason],...(details?[['Details',details] as [string,string]]:[]),['Owner',owner||'Unknown']],{href:`${env.SITE_ORIGIN}/admin`,label:'Review reports'});
}

// Weekly summary, sent by the Monday cron. The confirmation rate is the practical check
// that account email is reaching people.
export async function weeklySummary(env:Env){
 const week=now()-7*86400;
 const s=await env.DB.prepare(`SELECT
  (SELECT COUNT(*) FROM accounts WHERE disabled=0 AND email NOT LIKE 'deleted:%') AS accounts,
  (SELECT COUNT(*) FROM accounts WHERE created_at>?1 AND email NOT LIKE 'deleted:%') AS joined,
  (SELECT COUNT(*) FROM accounts WHERE created_at>?1 AND verified_at IS NOT NULL AND email NOT LIKE 'deleted:%') AS confirmed,
  (SELECT COUNT(*) FROM videos WHERE status='ready') AS videos,
  (SELECT COUNT(*) FROM videos WHERE status='ready' AND created_at>?1) AS shared,
  (SELECT COALESCE(SUM(size),0) FROM videos WHERE status IN ('ready','uploading')) AS bytes,
  (SELECT COUNT(*) FROM reports WHERE resolved=0) AS reports,
  (SELECT COUNT(*) FROM devices WHERE revoked=0 AND website=0) AS computers`).bind(week).first<Record<string,number>>();
 if(!s)return false;
 const rate=s.joined?`${s.confirmed} of ${s.joined} (${Math.round(s.confirmed/s.joined*100)}%)`:'No new accounts';
 // R2 storage is about $0.015 per GB-month.
 const cost=`$${(s.bytes/1024**3*0.015).toFixed(2)} a month`;
 return send(env,`VidCapture this week: ${s.joined} new ${s.joined===1?'account':'accounts'}`,'VidCapture this week',[
  ['New accounts',String(s.joined)],['Confirmed their email',rate],['All accounts',String(s.accounts)],['Connected computers',String(s.computers)],
  ['Videos shared this week',String(s.shared)],['All videos',String(s.videos)],['Storage',`${formatBytes(s.bytes)}, about ${cost}`],['Open reports',String(s.reports)],
 ],{href:`${env.SITE_ORIGIN}/admin`,label:'Open moderation'});
}
