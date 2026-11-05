const form = document.getElementById('sms-support-request');
const question = document.getElementById('sms-question');
const phone = document.getElementById('sms-phone');
const consent = document.getElementById('sms-consent');
const openMessage = document.getElementById('sms-open-message');

function updateMessage() {
  const phoneDigits = phone.value.replace(/\D/g, '');
  const ready = consent.checked && question.value.trim().length >= 5 && phone.validity.valid && phoneDigits.length >= 7 && phoneDigits.length <= 15;
  openMessage.setAttribute('aria-disabled', String(!ready));
  if (!ready) {
    openMessage.removeAttribute('href');
    return;
  }
  const body = `I request SMS support from Arosa (AROSA AI LLC) at ${phone.value.trim()} and agree to receive replies and follow-up about this request. My question: ${question.value.trim()}`;
  openMessage.href = `sms:+12406982365?body=${encodeURIComponent(body)}`;
}

form.addEventListener('input', updateMessage);
form.addEventListener('change', updateMessage);
form.addEventListener('submit', event => event.preventDefault());
openMessage.addEventListener('click', event => {
  if (openMessage.getAttribute('aria-disabled') === 'true') {
    event.preventDefault();
    form.reportValidity();
  }
});
updateMessage();
