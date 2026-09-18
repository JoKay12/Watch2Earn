// Rewards / redemption panel: tier selection, redemption requests, the
// redemption history list, and the points ledger. Split out of app.js as a
// self-contained feature slice — every DOM element it touches (redeem-tab,
// redeem-form, redeem-tier-list, redemption-list, ledger-list) belongs only
// to the rewards page. initRewards() takes refreshBalance as a parameter
// (rather than importing app.js, which would create a circular module
// dependency) since the balance-meter display it updates is owned by
// app.js's own boot/balance code.
import { $, escapeHtml, showToast, setButtonBusy } from './app-ui.js';
import { api } from './app-api.js';
import { state } from './app-state.js';

function formatRewardAmount(rewardType, tier) {
  if (rewardType === 'airtime') return `${Number(tier.airtime_ghs)} GHS`;
  if (rewardType === 'cash') return `${Number(tier.cash_ghs)} GHS`;
  return `${Number(tier.data_ghs)} GHS`;
}

const REWARD_AMOUNT_FIELD = { cash: 'cash_ghs', airtime: 'airtime_ghs', data_bundle: 'data_ghs' };

let selectedRedeemTier = null;

export function renderRedeemTiers() {
  selectedRedeemTier = null;
  $('redeem-submit-btn').disabled = true;
  const list = $('redeem-tier-list');
  const balance = state.user.points_balance;
  const amountField = REWARD_AMOUNT_FIELD[state.redeemType];

  const tiers = state.rewardTiers.filter((t) => t[amountField] !== null);
  if (!tiers.length) {
    list.innerHTML = '<p class="note">No reward tiers configured for this type yet.</p>';
    return;
  }

  list.innerHTML = tiers.map((tier) => {
    const affordable = balance >= tier.points_required;
    return `
      <label class="redeem-tier-option ${affordable ? '' : 'disabled'}">
        <input type="radio" name="redeem-tier" value="${tier.points_required}" ${affordable ? '' : 'disabled'}>
        <span class="redeem-tier-points">${tier.points_required.toLocaleString()} pts</span>
        <span class="redeem-tier-amount">${formatRewardAmount(state.redeemType, tier)}</span>
      </label>
    `;
  }).join('');

  list.querySelectorAll('input[name="redeem-tier"]').forEach((input) => {
    input.onchange = () => {
      selectedRedeemTier = Number(input.value);
      $('redeem-submit-btn').disabled = false;
    };
  });
}

export async function renderRedemptions() {
  const list = $('redemption-list');
  list.innerHTML = '<p class="note">Loading…</p>';
  let rows;
  try {
    rows = await api('/redemptions');
  } catch (err) {
    list.innerHTML = `<p class="note error">Couldn't load your redemptions (${escapeHtml(err.message)}). Try again in a moment.</p>`;
    return;
  }
  if (!rows.length) {
    list.innerHTML = '<p class="note">No redemption requests yet.</p>';
    return;
  }
  list.innerHTML = '';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'ticket-row';
    const statusNote = r.status === 'pending'
      ? 'Pending — usually reviewed and sent within 24 hours'
      : r.status === 'fulfilled'
        ? 'Sent to your destination'
        : 'Points refunded to your balance';
    row.innerHTML = `
      <span class="ticket-type">${r.reward_amount_label ? escapeHtml(r.reward_amount_label) : escapeHtml(r.reward_type.replace('_', ' '))}</span>
      <span class="ticket-points">${r.points_spent} pts</span>
      <span class="ticket-status ${r.status}">${r.status}</span>
      <span class="note">${escapeHtml(statusNote)}</span>
    `;
    list.appendChild(row);
  }
}

export async function renderLedger() {
  const list = $('ledger-list');
  list.innerHTML = '<p class="note">Loading…</p>';
  let rows;
  try {
    rows = await api('/ledger');
  } catch (err) {
    list.innerHTML = `<p class="note error">Couldn't load your points activity (${escapeHtml(err.message)}). Try again in a moment.</p>`;
    return;
  }
  if (!rows.length) {
    list.innerHTML = '<p class="note">No points activity yet — watch a video to get started.</p>';
    return;
  }
  list.innerHTML = '';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'ticket-row';
    const positive = r.points > 0;
    row.innerHTML = `
      <span class="ticket-type">${escapeHtml(r.reason.replace('_', ' '))}</span>
      <span class="ticket-points" style="color:${positive ? 'var(--mint)' : 'var(--danger)'}">${positive ? '+' : ''}${r.points} pts</span>
      <span class="note">${new Date(r.created_at).toLocaleDateString()}</span>
    `;
    list.appendChild(row);
  }
}

// Wires the redeem-type tabs and the redemption request form. Called once
// from app.js during startup.
export function initRewards({ refreshBalance }) {
  document.querySelectorAll('.redeem-tab').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.redeem-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.redeemType = btn.dataset.type;
      $('redeem-type').value = state.redeemType;
      renderRedeemTiers();
    };
  });

  $('redeem-form').onsubmit = async (e) => {
    e.preventDefault();
    $('redeem-message').textContent = '';
    if (!selectedRedeemTier) {
      $('redeem-message').textContent = 'Pick a reward tier first.';
      return;
    }
    const submitButton = e.target.querySelector('button[type="submit"]');
    setButtonBusy(submitButton, true, 'Requesting...');
    try {
      await api('/redeem', {
        method: 'POST',
        body: JSON.stringify({
          pointsRequired: selectedRedeemTier,
          rewardType: $('redeem-type').value,
          destination: $('redeem-destination').value,
        }),
      });
      $('redeem-message').textContent = 'Redemption requested — an admin will verify and send it within 24 hours.';
      showToast('Redemption request submitted — allow up to 24 hours for review.', 'success');
      await refreshBalance();
      renderRedeemTiers();
      await renderRedemptions();
    } catch (err) {
      $('redeem-message').textContent = err.message;
      showToast(err.message, 'error');
    } finally {
      setButtonBusy(submitButton, false);
    }
  };
}
