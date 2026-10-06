(async () => {
  const wait = async condition => { for (let i=0;i<160;i++) { if (condition()) return; await new Promise(r=>setTimeout(r,100)); } throw new Error('UI wait timed out'); };
  const shot = async name => { await new Promise(r=>setTimeout(r,650)); await window.__TAURI__.core.invoke('test_step',{name,passed:true}); };
  const assert = value => { if (!value) throw new Error('UI assertion failed'); };
  const call = async (name,value) => {const response=await window.launcher[name](value);if(!response.ok)throw new Error('Native action failed');return response.result;};
  try {
    await wait(()=>document.getElementById('connection').textContent.includes('Private network') && !document.getElementById('submit').disabled);
    assert(typeof window.require==='undefined');assert((await call('updateState')).phase==='disabled');
    assert(!document.body.textContent.toLowerCase().includes('rust preview'));
    await document.fonts.ready;
    await shot('login');
    document.getElementById('tab-register').click();await shot('register');
    document.querySelector('.content').scrollTop=document.querySelector('.content').scrollHeight;await shot('register-bottom');
    const createButton=document.getElementById('submit').getBoundingClientRect();assert(createButton.bottom<=document.querySelector('.content').getBoundingClientRect().bottom+1);
    document.querySelector('.content').scrollTop=0;
    document.getElementById('claim-mode').click();await shot('claim');
    assert(document.querySelector('.content').classList.contains('signup-visible'));
    document.querySelector('.content').scrollTop=document.querySelector('.content').scrollHeight;await shot('claim-bottom');
    assert(document.getElementById('submit').getBoundingClientRect().bottom<=document.querySelector('.content').getBoundingClientRect().bottom+1);
    document.querySelector('.content').scrollTop=0;
    document.getElementById('tab-login').click();
    document.getElementById('settings-open').click();await wait(()=>document.getElementById('game-settings').open);
    assert(!document.getElementById('display-settings').hidden);await shot('settings');
    document.getElementById('settings').open=true;await shot('settings-server');document.getElementById('settings').open=false;
    document.querySelector('#setting-language .next').click();
    document.getElementById('settings-save').click();await wait(()=>!document.getElementById('game-settings').open);
    assert((await call('settings')).language==='en');
    await wait(()=>!document.getElementById('news-preview').hidden);
    document.getElementById('news-open').click();assert(document.getElementById('news').open);await shot('news');
    document.getElementById('news-tabs').children[1].click();await shot('news-fixes');
    document.getElementById('news-close').click();await wait(()=>!document.getElementById('news-preview').inert);
    document.getElementById('tab-register').click();
    const name='UI'+String(Date.now()).slice(-10);
    for (const [id,value] of [['username',name],['password','local-test-password-2026'],['confirm-password','local-test-password-2026']]) document.getElementById(id).value=value;
    document.getElementById('account-form').requestSubmit();
    await wait(()=>!document.getElementById('play-panel').hidden && !document.getElementById('logout').disabled);
    assert(document.getElementById('player-name').textContent===name);assert(document.getElementById('password').value==='');await shot('signed-in');
    document.getElementById('logout').click();await wait(()=>!document.getElementById('auth').hidden && !document.getElementById('submit').disabled);await shot('signed-out');
    await window.__TAURI__.core.invoke('test_step',{name:'resize-minimum',passed:true});await shot('minimum-login');
    assert(document.getElementById('submit').getBoundingClientRect().right<=innerWidth);
    await window.__TAURI__.core.invoke('test_step',{name:'finish',passed:true});
  } catch {
    await window.__TAURI__.core.invoke('test_step',{name:'failed',passed:false});
  }
})();
