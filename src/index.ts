export interface Env {
  GEMINI_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  GOOGLE_SCRIPT_URL: string;
  SHEETS_SECRET: string;
  GEMINI_MODEL?: string;
}
interface Update {
  message?: {
    chat: { id: number };
    photo?: Array<{ file_id: string }>;
    caption?: string;
  };
}
interface Book {
  title: string; author: string; price_from: number | null; price_to: number | null;
  min_price_url: string; source_note: string;
}
const TG = "https://api.telegram.org";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/";
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") return out({ok:true,service:"book-scanner"});
    if (req.method === "GET" && url.pathname === "/diagnose") {
      return out({ok:true, secretConfigured: Boolean(env.SHEETS_SECRET), secretLength: (env.SHEETS_SECRET || "").length});
    }
    if (req.method === "GET" && url.pathname.startsWith("/register/")) {
      const secret = decodeURIComponent(url.pathname.slice(10));
      if (!env.SHEETS_SECRET || secret !== env.SHEETS_SECRET) return out({ok:false,error:"Unauthorized"},401);
      const webhook = url.origin + "/telegram/webhook";
      const result = await tg(env,"setWebhook",{url:webhook,secret_token:env.SHEETS_SECRET,allowed_updates:["message"]});
      return out({ok:true,webhook,telegram:result});
    }
    if (req.method === "POST" && url.pathname === "/telegram/webhook") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.SHEETS_SECRET) return new Response("Unauthorized",{status:401});
      let update: Update;
      try { update = await req.json() as Update; } catch { return new Response("Bad Request",{status:400}); }
      if (update.message?.chat?.id) {
        if (update.message.photo?.length) ctx.waitUntil(handlePhoto(update.message,env));
        else ctx.waitUntil(send(env,update.message.chat.id,"Отправь фото обложки книги — распознаю и добавлю отдельной строкой в таблицу."));
      }
      return new Response("OK");
    }
    return new Response("Not found",{status:404});
  }
};
async function handlePhoto(message: NonNullable<Update["message"]>,env:Env) {
  const chat=message.chat.id;
  try {
    await send(env,chat,"📚 Фото получил. Распознаю книгу и ищу цены…");
    const photos=message.photo!;
    const file=await tg(env,"getFile",{file_id:photos[photos.length-1].file_id});
    const path=file?.result?.file_path;
    if (!path) throw new Error("Telegram не вернул файл фотографии");
    const image=await fetch(`${TG}/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
    if (!image.ok) throw new Error("Не удалось скачать фото");
    const bytes=await image.arrayBuffer();
    if(bytes.byteLength>20*1024*1024) throw new Error("Фото больше 20 МБ");
    const headerMime=(image.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();
    const mime=headerMime.startsWith("image/")?headerMime:imageMimeFromPath(path);
    const book=await inspectBook(toBase64(bytes),mime,message.caption||"",env);
    if(!book.title) throw new Error("Название не распознано. Попробуй прислать фото обложки крупнее.");
    const saved=await fetch(env.GOOGLE_SCRIPT_URL,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      secret:env.SHEETS_SECRET,title:book.title,author:book.author,price_from:book.price_from,price_to:book.price_to,
      min_price_url:book.min_price_url,source_note:book.source_note,date:new Date().toISOString()
    })});
    const result=await saved.json() as any;
    if(!saved.ok||result?.ok!==true) throw new Error(result?.error||"Google Таблица не подтвердила запись");
    const prices=book.price_from===null?"цена не найдена":`${rub(book.price_from)}–${rub(book.price_to??book.price_from)} ₽`;
    await send(env,chat,`✅ Добавлено в таблицу отдельной строкой\n\n📖 <b>${esc(book.title)}</b>\n✍️ ${esc(book.author||"Автор не определён")}\n💰 ${prices}\n🔎 ${esc(book.source_note||"Источники не указаны")}`);
  } catch(e) { await send(env,chat,"❌ "+esc(e instanceof Error?e.message:String(e))); }
}
function imageMimeFromPath(path:string):string{
  const ext=path.toLowerCase().split("?")[0].split(".").pop()||"";
  const types:Record<string,string>={jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",gif:"image/gif",bmp:"image/bmp",heic:"image/heic"};
  return types[ext]||"image/jpeg";
}
async function inspectBook(image:string,mime:string,caption:string,env:Env):Promise<Book>{
  const model=env.GEMINI_MODEL||"gemini-3.8-flash";
  const prompt=`Определи книгу по фото обложки: точное название, автора, по возможности конкретное издание. Не угадывай нечитаемые данные — если автор неизвестен, верни пустую строку. Подпись пользователя: ${caption||"нет"}.
На этом этапе НЕ ищи цены и НЕ выдумывай ссылки или стоимость. Для price_from и price_to верни null, для min_price_url верни пустую строку. В source_note напиши: "Название и автор распознаны; оценка цен будет выполнена отдельным этапом".
Верни только JSON: {"title":"строка","author":"строка","price_from":null,"price_to":null,"min_price_url":"","source_note":"строка"}`;
  const response=await fetch(`${GEMINI}${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt},{inline_data:{mime_type:mime,data:image}}]}],
      generationConfig:{temperature:0.1,responseMimeType:"application/json"}})
  });
  const data=await response.json() as any;
  if(!response.ok) throw new Error(data?.error?.message||`Gemini API HTTP ${response.status}`);
  const raw=data?.candidates?.[0]?.content?.parts?.map((p:any)=>p.text||"").join("")||"";
  const parsed=parseJson(raw);
  return {title:str(parsed.title),author:str(parsed.author),price_from:null,price_to:null,min_price_url:"",source_note:str(parsed.source_note)||"Книга распознана; цены пока не оценивались"};
}
function parseJson(s:string):any{const t=s.replace(/^```(?:json)?/i,"").replace(/```$/i,"").trim();const a=t.indexOf("{"),b=t.lastIndexOf("}");if(a<0||b<=a)throw new Error("Gemini вернул ответ без JSON");return JSON.parse(t.slice(a,b+1));}
async function tg(env:Env,method:string,body:Record<string,unknown>):Promise<any>{
  const r=await fetch(`${TG}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json() as any;if(!r.ok||!d.ok)throw new Error(d.description||"Ошибка Telegram API");return d;
}
async function send(env:Env,chat:number,text:string){await tg(env, "sendMessage",{chat_id:chat,text,parse_mode:"HTML",disable_web_page_preview:true});}
function toBase64(buf:ArrayBuffer){const a=new Uint8Array(buf);let s="";for(let i=0;i<a.length;i+=0x8000)s+=String.fromCharCode(...a.subarray(i,i+0x8000));return btoa(s);}
function str(v:unknown){return typeof v==="string"?v.trim().slice(0,2000):"";}
function price(v:unknown):number|null{const n=typeof v==="number"?v:Number(v);return Number.isFinite(n)&&n>0?Math.round(n):null;}
function rub(n:number){return new Intl.NumberFormat("ru-RU").format(n);}
function esc(s:string){return s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]||c));}
function out(v:unknown,status=200){return new Response(JSON.stringify(v),{status,headers:{"content-type":"application/json; charset=utf-8"}});}
