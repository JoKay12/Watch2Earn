const $ = (id) => document.getElementById(id);

function showOnly(id) {
  ['reset-loading', 'reset-form', 'reset-invalid', 'reset-success'].forEach((elId) => {
    $(elId).classList.toggle('hidden', elId !== id);
  });
}

async function init() {
  let sb;
  try {
    const configRes = await fetch('/api/config');
    const { supabaseUrl, supabaseAnonKey } = await configRes.json();
    if (!window.supabase) throw new Error('Supabase client library failed to load');
    sb = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
  } catch (err) {
    $('reset-error').textContent = 'Could not load the password reset tool. Check your connection and reload this page.';
    showOnly('reset-invalid');
    return;
  }

  // Clicking the link in the reset email lands here with recovery tokens in
  // the URL hash. supabase-js parses that automatically and fires this event
  // once it's established a temporary "recovery" session.
  let recoveryReady = false;
  sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') {
      recoveryReady = true;
      showOnly('reset-form');
    }
  });

  // If the link was invalid/expired/already used, no PASSWORD_RECOVERY event
  // will fire. Give it a few seconds, then show the "invalid link" state.
  setTimeout(() => {
    if (!recoveryReady) showOnly('reset-invalid');
  }, 4000);

  document.querySelectorAll('.password-toggle').forEach((btn) => {
    btn.onclick = () => {
      const input = $(btn.dataset.target);
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'Show' : 'Hide';
    };
  });

  $('reset-form').onsubmit = async (e) => {
    e.preventDefault();
    $('reset-error').textContent = '';
    const { error } = await sb.auth.updateUser({ password: $('reset-password').value });
    if (error) {
      $('reset-error').textContent = error.message;
      return;
    }
    showOnly('reset-success');
  };
}

init();
