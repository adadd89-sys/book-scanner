export interface Env {
  GEMINI_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  GOOGLE_SCRIPT_URL: string;
  SHEETS_SECRET: string;
  GEMINI_MODEL?: string;
  GEMINI_FALLBACK_MODEL?: string;
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
    const ozonResult=await searchOzonPrices(book,env);
    if(ozonResult){book.price_from=ozonResult.price_from;book.price_to=ozonResult.price_to;book.min_price_url=ozonResult.min_price_url;book.source_note=ozonResult.source_note;}
    else {book.source_note="Книга распознана; подтверждённые предложения Ozon не найдены или поиск временно недоступен";}
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
  const prompt=`Определи книгу по фото обложки: точное название, автора, по возможности конкретное издание. Не угадывай нечитаемые данные — если автор неизвестен, верни пустую строку. Подпись пользователя: ${caption||"нет"}.
На этом этапе НЕ ищи цены и НЕ выдумывай ссылки или стоимость. Для price_from и price_to верни null, для min_price_url верни пустую строку. В source_note напиши: "Название и автор распознаны; оценка цен будет выполнена отдельным этапом".
Верни только JSON: {"title":"строка","author":"строка","price_from":null,"price_to":null,"min_price_url":"","source_note":"строка"}`;
  const payload={contents:[{role:"user",parts:[{text:prompt},{inline_data:{mime_type:mime,data:image}}]}],
    generationConfig:{responseMimeType:"application/json",thinkingConfig:{thinkingLevel:"LOW"}}};
  const models=["gemini-4-hydrogen",env.GEMINI_FALLBACK_MODEL||"gemini-3.8-flash"];
  let lastError="Gemini temporarily unavailable";
  const deadline=Date.now()+20000;
  for(const candidate of models){
    try{
      const remaining=deadline-Date.now();
      if(remaining<1500) break;
      const response=await fetch(`${GEMINI}${encodeURIComponent(candidate)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload),
        signal:AbortSignal.timeout(Math.min(9000,remaining-500))
      });
      const data=await response.json() as any;
      if(!response.ok){
        lastError=data?.error?.message||`Gemini API HTTP ${response.status}`;
        continue;
      }
      const raw=data?.candidates?.[0]?.content?.parts?.map((p:any)=>p.text||"").join("")||"";
      if(!raw){lastError=`Модель ${candidate} вернула пустой ответ`;continue;}
      const parsed=parseJson(raw);
      const title=str(parsed.title);
      if(!title){lastError=`Модель ${candidate} не распознала название книги`;continue;}
      return {title,author:str(parsed.author),price_from:null,price_to:null,min_price_url:"",source_note:str(parsed.source_note)||"Книга распознана; цены пока не оценивались"};
    }catch(e){lastError=e instanceof Error?e.message:String(e);}
  }
  throw new Error("Обе модели Gemini не завершили распознавание. Подробности: "+lastError);
}
async function searchOzonPrices(book:Book,env:Env):Promise<{price_from:number|null;price_to:number|null;min_price_url:string;source_note:string}|null>{
  const prompt=`Найди реальные предложения ТОЛЬКО на Ozon.ru для книги:
Название: "${book.title}"
Автор: "${book.author}"
Ищи точное совпадение названия и автора. Допускаются новые и бывшие в употреблении экземпляры, если карточка именно этой книги. Не используй другие маркетплейсы, объявления, библиотеки или цены из памяти.
Верни только JSON без markdown:
{"offers":[{"price":число_в_рублях,"url":"полная ссылка на карточку товара Ozon","title":"название из карточки","condition":"новая/б\u002fy"}]}
Включай только предложения, для которых в найденном результате действительно видны цена и ссылка на конкретную карточку товара Ozon. Не выдумывай цены, URL или товары. Если точных предложений нет, верни {"offers":[]}. Не включай поисковую страницу вместо карточки товара.`;
  const models=["gemini-4-hydrogen","gemini-3.8-flash"];
  let lastError="";
  const searchDeadline=Date.now()+9500;
  for(const model of models){
    try{
      const remaining=searchDeadline-Date.now();
      if(remaining<1000)break;
      const response=await fetch("https://generativelanguage.googleapis.com/v1beta/interactions",{
        method:"POST",
        headers:{"content-type":"application/json","x-goog-api-key":env.GEMINI_API_KEY,"Api-Revision":"2026-05-20"},
        body:JSON.stringify({model,input:prompt,tools:[{type:"google_search"}]}),
        signal:AbortSignal.timeout(Math.min(5000,remaining-250))
      });
      const data=await response.json() as any;
      if(!response.ok){lastError=data?.error?.message||`HTTP ${response.status}`;continue;}
      const interaction=data?.interaction||data;
      const steps=interaction?.steps||[];
      const raw=steps.filter((s:any)=>s.type==="model_output").flatMap((s:any)=>s.content||[])
        .filter((c:any)=>c.type==="text").map((c:any)=>c.text||"").join("\n")
        ||interaction?.output_text||data?.output_text||"";
      if(!raw){lastError="Поиск вернул пустой ответ";continue;}
      const parsed=parseJson(raw);
      const offers=Array.isArray(parsed.offers)?parsed.offers:[];
      const valid=offers.map((o:any)=>{
        const value=price(o.price);
        const url=str(o.url);
        try{
          const u=new URL(url);
          if(u.protocol!=="https:"||!(u.hostname==="ozon.ru"||u.hostname.endsWith(".ozon.ru"))||!value)return null;
          return {price:value,url};
        }catch{return null;}
      }).filter((o:any)=>o!==null) as Array<{price:number;url:string}>;
      if(!valid.length)return {price_from:null,price_to:null,min_price_url:"",source_note:"На Ozon не найдено подтверждённых карточек с ценой для точного совпадения книги"};
      const prices=valid.map(o=>o.price);
      const min=Math.min(...prices),max=Math.max(...prices);
      const cheapest=valid.find(o=>o.price===min)!;
      return {price_from:min,price_to:max,min_price_url:cheapest.url,source_note:`Ozon: проверено ${valid.length} предложений; диапазон по найденным карточкам`};
    }catch(e){lastError=e instanceof Error?e.message:String(e);}
  }
  return null;
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
