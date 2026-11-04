// The beta application form: checks the required fields in the page, sends the application to
// Arosa, and replaces the form with a confirmation once it is in.
const form = globalThis.document?.querySelector('#beta-form');
const status = globalThis.document?.querySelector('#beta-status');

export function betaApplicationProblem(data) {
  if (!data.name) return 'Enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) return 'Enter a valid email address.';
  if (!data.role) return 'Choose what best describes you.';
  return '';
}

if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value).trim()]));
    const problem = betaApplicationProblem(data);
    status.classList.toggle('error', Boolean(problem));
    if (problem) {
      status.textContent = problem;
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = 'Sending your application…';
    try {
      const response = await fetch('/api/public/beta-apply', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'We could not send your application. Try again in a minute.');
      const done = document.createElement('div');
      done.className = 'beta-done';
      done.setAttribute('role', 'status');
      const title = document.createElement('strong');
      title.textContent = `Thanks, ${data.name.split(' ')[0]}. Your application is in.`;
      const note = document.createElement('p');
      note.textContent = 'We will reply by email.';
      done.append(title, note);
      form.replaceChildren(done);
    } catch (error) {
      status.classList.add('error');
      status.textContent = error.message;
      button.disabled = false;
    }
  });
}
