const page=document.getElementById('page');
const path=location.pathname;
const pageNames={'/':'Your interview, connected','/how-it-works':'How it works','/pricing':'Pricing','/account':'Your account','/admin':'Administration'};
document.title='AnswerDuo · '+(pageNames[path]||'Interview assistant');
for(const link of document.querySelectorAll('nav a')){
  if(link.getAttribute('href')===path)link.setAttribute('aria-current','page');
}
const steps=`
<div class="cards">
<article class="card"><h3>Set up on your computer</h3><p>Bring your own OpenAI or Gemini API key. You are responsible for any provider usage charges. Share your meeting tab with audio, and optionally choose a window for screen analysis.</p></article>
<article class="card"><h3>Pair your phone</h3><p>Scan the private pairing code. Follow the live transcript on your phone while you keep the meeting in view.</p></article>
<article class="card"><h3>Ask when you’re ready</h3><p>Tap Answer question for a response with context. Tap Analyze screen for a fresh view of a coding problem and a walkthrough.</p></article>
</div>`;
async function api(url,body?){
  const response=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  const data=await response.json();
  if(!response.ok)throw Error(data.message||'Request could not be completed.');
  return data;
}
function message(text){document.getElementById('message').textContent=text;}
const themeButton=document.getElementById('theme');
try{document.documentElement.dataset.theme=localStorage.getItem('answerduo-theme')||'dark';}catch{}
function updateThemeButton(){
  const light=document.documentElement.dataset.theme==='light';
  themeButton.textContent=light?'☀':'☾';
  themeButton.setAttribute('aria-label',light?'Switch to dark theme':'Switch to light theme');
}
updateThemeButton();
themeButton.onclick=()=>{
  document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light';
  try{localStorage.setItem('answerduo-theme',document.documentElement.dataset.theme);}catch{}
  updateThemeButton();
};
if(path==='/'){
  const features=[
    ['☏','Live meeting transcript','Follow the interviewer’s words on your phone. Capture meeting-tab audio while wearing headphones.'],
    ['⌘','Coding, explained','Analyze a fresh screenshot for working code, an explanation, a concrete walkthrough, and complexity.'],
    ['▤','Your experience, in context','Import a CV or add project notes to help shape personal answers around your actual background.'],
    ['⇄','Two devices, one workspace','Pair your phone with a private QR code. Keep capture on your computer and answers within reach.'],
    ['⌁','Questions with context','Keep follow-up constraints with the latest question. Request a concise response when you’re ready.'],
    ['⚿','Your key, your control','Your API key is kept only for your active session. We don’t save it to our database or share it with your paired phone.']
  ];
  page.innerHTML=`<section class="hero"><div class="hero-layout"><div class="hero-inner"><span class="hero-badge"><span aria-hidden="true">✧</span> Bring your own API key</span><h1>See interview questions and suggested answers <em>on your phone.</em></h1><p>Connect your meeting on your computer to a personal companion on your phone. Bring your own OpenAI or Gemini API key to get answers with context and code you can walk through.</p><div class="cta"><a class="button" href="/app">Try 20 minutes free <span aria-hidden="true">→</span></a><a class="button secondary" href="#demo"><span aria-hidden="true">▶</span> See it in action</a></div><div class="hero-note"><span>ϟ &nbsp; 7 days free with registration</span><span>No credit card required by AnswerDuo</span></div><div class="byok-notice"><strong>Your API key. Your provider bill.</strong><span>You are responsible for any OpenAI or Gemini API charges incurred using your key. Free trials cover AnswerDuo access only; AI usage is separate.</span></div></div><aside class="hero-preview" aria-label="Example phone companion"><div class="preview-heading"><strong>Phone companion</strong><span>● Connected</span></div><div class="preview-question"><span class="eyebrow">The interviewer asks</span><h3>How did you approach the most challenging part?</h3></div><button class="button secondary" id="hero-answer">Answer question</button><div class="preview-response" id="hero-result" hidden><span class="eyebrow">Your answer, with context</span><p>“Our import slowed down because it checked each row separately. I batched those checks and measured the import time again on the same file.”</p></div><p class="preview-note">Illustrative response · Personalize with your project notes</p></aside></div><div class="facts"><div><strong>7 days</strong><span>Free with registration</span></div><div><strong>2 screens</strong><span>Computer and phone</span></div><div><strong>2 providers</strong><span>OpenAI or Gemini</span></div><div><strong>Your key</strong><span>Your provider account</span></div></div></section>
  <section id="features" class="section"><div class="center"><h2>Support for every part of the conversation</h2><p>From a personal introduction to a coding challenge, keep your next step in view.</p></div><div class="cards features">${features.map(([icon,title,description])=>`<article class="card feature"><span class="feature-icon" aria-hidden="true">${icon}</span><div><h3>${title}</h3><p>${description}</p></div></article>`).join('')}</div></section>
  <section id="demo" class="section"><div class="center"><h2>See it in action</h2><p>A focused view for the device in your hand.</p></div><div class="product-demo"><div class="demo-top"><span class="status">● Connected to your computer</span><span>Phone companion · example</span></div><div class="demo-tabs" role="group" aria-label="Demo example"><button id="demo-question" aria-pressed="true">Answer question</button><button id="demo-code" aria-pressed="false">Analyze screen</button></div><div id="demo-content" aria-live="polite"></div></div></section>
  <section class="section"><div class="center"><h2>Ready in a few steps</h2><p>Keep the meeting on your computer. Bring your phone alongside.</p></div>${steps}</section>
  <section class="section privacy"><div><span class="eyebrow">Built around your control</span><h2>Know where your key goes.</h2><p>Your computer sends the key to AnswerDuo’s relay, which authenticates requests to your chosen AI provider. In the deployed HTTPS app, those connections are encrypted in transit.</p></div><div class="card"><h3>Session memory, with a clear end</h3><p>Your API key is kept only for your active session. We don’t save it to our database or share it with your paired phone. Ending the session stops capture and cancels requests.</p><a href="#faq">Read about keys and session data ↓</a></div></section><section id="faq" class="section faq"><div class="center"><h2>A few things you might be wondering</h2></div><details><summary>Who pays for AI usage?</summary><p>AnswerDuo is a bring-your-own-key app. You connect your own OpenAI or Gemini API key, and you are responsible for any charges the provider bills to your account. AnswerDuo trials and licenses do not include AI credits or cover provider bills. Review your provider’s pricing and monitor your API usage in its dashboard.</p></details><details><summary>Do I need a credit card to try it?</summary><p>No. Try the app for 20 minutes of session time as a guest. Register to start a 7-day free trial. AnswerDuo does not require a credit card for the free trial. Your AI provider may have separate billing requirements. A license will be required afterward; activation is coming soon. You need your own OpenAI or Gemini API key, and provider usage is billed separately.</p></details><details><summary>How does my phone connect?</summary><p>Start a session in desktop Chrome and scan the private pairing code. Keep the computer host tab open while using the companion in your phone browser.</p></details><details><summary>Can I use headphones?</summary><p>Yes. Select the meeting tab and enable tab audio. The computer captures the shared tab’s audio without microphone permission.</p></details><details><summary>How is my API key handled?</summary><p>Your API key is kept only for your active session. We don’t save it to our database or share it with your paired phone. In an HTTPS deployment, it travels over encrypted connections to the AnswerDuo server and your selected AI provider.</p></details><details><summary>What happens to my CV and interview content?</summary><p>Your notes and recent transcript are sent through the server to your selected provider when you request an answer. Session content stays in server memory. Provider data policies also apply.</p></details><details><summary>Can I purchase a membership?</summary><p>Membership purchasing is currently paused. Try 20 minutes as a guest or register for a 7-day free trial. Neither requires a credit card.</p></details></section>
  <section class="section final-cta"><h2>Make room for a clearer answer.</h2><a class="button" href="/app">Try AnswerDuo free →</a></section>`;
  document.getElementById('hero-answer').onclick=event=>{
    document.getElementById('hero-result').hidden=false;event.currentTarget.hidden=true;
  };
  const examples={
    question:'<span class="eyebrow">Current question</span><h3>How would you make this solution faster?</h3><span class="eyebrow">Answer</span><p>I’d use a hash map to remember values we’ve already visited. That lets us look up each complement in a single pass, giving us O(n) time with O(n) additional space.</p>',
    code:'<span class="eyebrow">Screen analysis</span><h3>Find two numbers that add up to the target.</h3><pre><code>def two_sum(nums, target):\n    seen = {}\n    for i, value in enumerate(nums):\n        complement = target - value\n        if complement in seen:\n            return [seen[complement], i]\n        seen[value] = i\n    return []</code></pre><h3>Explanation</h3><p>The map stores each previously visited value and its index.</p><h3>Walkthrough</h3><p>For [2, 7, 11] with target 9, store 2 at index 0. At 7, the complement is 2, so return [0, 1].</p>'
  };
  function demo(mode){
    document.getElementById('demo-content').innerHTML=examples[mode];
    document.getElementById('demo-question').setAttribute('aria-pressed',String(mode==='question'));
    document.getElementById('demo-code').setAttribute('aria-pressed',String(mode==='code'));
  }
  document.getElementById('demo-question').onclick=()=>demo('question');
  document.getElementById('demo-code').onclick=()=>demo('code');
  demo('question');
}else if(path==='/how-it-works'){
  page.innerHTML=`<section class="section"><div class="center"><span class="eyebrow">How it works</span><h1>Your meeting.<br>Your companion.</h1><p>Desktop Chrome handles capture. Your phone reads the results.</p></div>${steps}<div class="card" style="margin-top:24px"><h3>Make the answers yours</h3><p>Add optional CV or project notes. Review imported text before using it. Personal answers draw on your notes and the transcript. Both are sent to your chosen provider when you request an answer.</p><p>Use AnswerDuo for practice and interviews where assistance and recording are permitted. Agree on capture with the participants.</p><p>Trial time runs while your guest session is open, including pauses. Ending a session saves unused time. A new browser or cleared cookies creates a new guest identity.</p><a class="button" href="/app">Open workspace ↗</a></div></section>`;
}else if(path==='/pricing'){
  page.innerHTML=`<section class="section pricing"><div class="center"><span class="eyebrow">Pricing</span><h1>A little support.<br>On your terms.</h1><p>Try 20 minutes as a guest, then register for 7 days free. Bring your own AI provider key.</p></div><div class="pricing-cards available-plans"><article class="plan"><div class="plan-head"><h2>Guest preview</h2><strong>20 minutes of session time</strong></div><div class="plan-body"><p>Use your minutes across sessions. No registration required.</p><a class="button secondary" href="/app">Try as guest</a></div></article><article class="plan"><div class="plan-head"><span class="eyebrow">Registered free trial</span><div class="price">$0 <small>for 7 calendar days from signup</small></div><p>No credit card required</p></div><div class="plan-body"><ul><li>Live transcript on your phone</li><li>Answers with question context</li><li>Code, explanation and walkthrough</li><li>CV and background notes</li><li>OpenAI or Gemini with your key</li></ul><a class="button secondary" href="/account">Start 7 days free →</a></div></article></div><details><summary>Upcoming paid plans</summary><div class="pricing-cards available-plans"><article class="plan"><div class="plan-head"><span class="eyebrow">Monthly</span><div class="price">$4 <small>/ month</small></div><p>Monthly license · Coming soon</p></div><div class="plan-body"><ul><li>All workspace features</li><li>No hourly usage cap</li><li>Bring your own OpenAI or Gemini key</li></ul><button disabled>Coming soon</button></div></article><article class="plan"><div class="plan-head"><span class="eyebrow">Lifetime</span><div class="price">$21 <small>once</small></div><p>Lifetime license · Coming soon</p></div><div class="plan-body"><ul><li>All workspace features</li><li>No hourly usage cap</li><li>Bring your own OpenAI or Gemini key</li></ul><button disabled>Coming soon</button></div></article></div></details><p class="center fine"><strong>Bring your own API key. You are responsible for any AI provider charges, including during free trials.</strong> AnswerDuo plans do not include AI credits. The guest preview includes 20 minutes of session time. Registration starts a 7-day free trial, including days you do not use the app. No credit card required. A license is required afterward; activation is coming soon.</p><p id="message" class="message center" role="status"></p></section>`;
  if(location.search.includes('trial=ended'))message('Your free access has ended. A license is required to continue. License activation is coming soon.');
}else if(path==='/account'){
  page.innerHTML=`<section class="section narrow"><span class="eyebrow">Your workspace</span><h1>Welcome back.</h1><p id="account-state">Loading account…</p><p class="byok-notice"><strong>Bring your own OpenAI or Gemini API key.</strong><span>The free trial covers AnswerDuo access only. You are responsible for any AI provider charges incurred using your key. AnswerDuo does not require a credit card for the trial.</span></p><form id="auth" class="form"><label>Email<input name="email" type="email" autocomplete="username" required maxlength="254"></label><label>Password<input name="password" type="password" id="account-password" autocomplete="current-password" minlength="1" maxlength="200" required><span class="fine">New passwords must contain at least 8 characters.</span></label><label class="password-toggle"><input type="checkbox" id="show-password"> Show password</label><div class="cta"><button name="action" value="login">Sign in</button><button class="secondary" name="action" value="signup">Register · 7 days free</button></div></form><p id="message" class="message" role="status"></p><div id="signed-in" hidden><a class="button" href="/app">Open workspace</a> <button class="secondary" id="logout">Sign out</button><p><a href="/pricing">View membership</a></p></div></section>`;
  document.getElementById('show-password').onchange=event=>{
    document.getElementById('account-password').type=event.target.checked?'text':'password';
  };
  const accessTime=account=>Math.ceil(account.remainingMs/86400000)+' days';
  async function refresh(){
    const account=await api('/api/account');
    document.getElementById('account-state').textContent=account.email
      ?'Signed in as '+account.email+'. '+(account.member?'Membership access active.':account.remainingMs>0?'Free trial: '+accessTime(account)+' remaining.':'Launch access ended. A license is required; activation is coming soon.')
      :(account.remainingMs>0?'Guest preview: '+Math.ceil(account.remainingMs/60000)+' minutes of session time remaining. Register for 7 days free. No credit card required.':'Your 20-minute guest preview has ended. Register for 7 days free. No credit card required.');
    document.getElementById('auth').hidden=!!account.email;
    document.getElementById('signed-in').hidden=!account.email;
    if(account.email)document.querySelector('h1').textContent='Your workspace.';
    if(account.role==='admin'){
      document.getElementById('admin-link')?.remove();
      const link=document.createElement('a');link.id='admin-link';link.className='admin-link';link.href='/admin';link.textContent='Open admin dashboard ↗';
      document.getElementById('signed-in').append(link);
    }
  }
  document.getElementById('auth').onsubmit=async event=>{
    event.preventDefault();const form=event.currentTarget;
    if(event.submitter.value==='signup'&&new FormData(form).get('password').length<8){message('Use a password of at least 8 characters.');return;}
    for(const button of form.querySelectorAll('button'))button.disabled=true;
    try{await api('/api/auth/'+event.submitter.value,Object.fromEntries(new FormData(form)));form.reset();message('');await refresh();}
    catch(error){message(error.message);}
    finally{for(const button of form.querySelectorAll('button'))button.disabled=false;}
  };
  document.getElementById('logout').onclick=async()=>{await api('/api/auth/logout',{});location.reload();};
  refresh().catch(error=>message(error.message));
}else if(path==='/admin'){
  page.innerHTML=`<section class="section"><span class="eyebrow">Administration</span><h1>Workspace overview.</h1><p>Visitors are counted once per browser each UTC day. Refreshing does not add a visitor. Signed-in admin visits are excluded. Clearing cookies or using another browser counts separately. Guest accounts count stored guest identities, including expired guests.</p><p id="message" class="message" role="status"></p><div id="metrics" class="metrics"></div><h2>Daily traffic</h2><div class="table-wrap"><table><thead><tr><th>Date (UTC)</th><th>Unique visitors</th></tr></thead><tbody id="traffic"></tbody></table></div><p class="fine">Download tracking is unavailable because AnswerDuo currently runs in the browser.</p></section>`;
  api('/api/admin').then(data=>{
    for(const [title,value] of [['Unique visitors (90 days)',data.uniqueVisitors],['Guest accounts',data.guests],['Registered accounts',data.accounts],['Paid memberships',data.paid],['Sessions started',data.sessions],['Sessions with phone paired',data.paired],['Sessions with first answer delivered',data.answered]]){
      const card=document.createElement('div');card.className='metric';
      const number=document.createElement('strong');number.textContent=value||0;
      const label=document.createElement('span');label.textContent=title;card.append(number,label);
      document.getElementById('metrics').append(card);
    }
    if(!data.traffic.length){
      const tr=document.createElement('tr'),td=document.createElement('td');
      td.colSpan=2;td.textContent='Visits will appear here as people open the site.';tr.append(td);
      document.getElementById('traffic').append(tr);
    }
    for(const row of data.traffic){
      const tr=document.createElement('tr');
      for(const value of [row.day,row.visitors]){const td=document.createElement('td');td.textContent=value;tr.append(td);}
      document.getElementById('traffic').append(tr);
    }
  }).catch(error=>message(error.message));
}

if(location.hash)requestAnimationFrame(()=>document.getElementById(location.hash.slice(1))?.scrollIntoView());
