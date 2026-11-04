import { chatRequest, postChat } from './chat-api.js';
import { routePath } from './core-route.js';
import { fmtDate, failLine } from './core-view.js';
import { fetchAddressSuggestions } from './nyc-address.mjs';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

// One library for every floor plan and building model, however it started; rows that began
// as underwriting say so instead of living in a separate list with its own search. A new
// model starts from a verified New York City address picked from the city directory, so it
// is linked to its parcel from the first minute; an address outside the directory can still
// start a model, plainly labeled as having no parcel link.
export function createModeling({ root, navigate, canStart, suggest = fetchAddressSuggestions }) {
  let generation = 0, cleanups = [];
  return {
    leave() { ++generation; cleanups.forEach(cleanup => cleanup()); cleanups = []; },
    show() {
      const visit = ++generation;
      document.title = 'Modeling · Arosa';
      const page = el('div', 'core-screen modeling-library');
      const head = el('header', 'core-screen-head');
      const create = el('button', 'core-follow primary', 'New model');
      create.type = 'button'; create.disabled = !canStart();
      create.setAttribute('aria-expanded', 'false');
      create.setAttribute('aria-controls', 'new-model-form');
      head.append(el('h1', 'core-title', 'Modeling'), create);
      const form = el('form', 'modeling-create');
      form.id = 'new-model-form'; form.hidden = true;
      const addressWrap = el('div', 'modeling-address-field');
      const addressLabel = el('label', '', 'Property address'), address = el('input');
      address.name = 'address'; address.required = true; address.maxLength = 200;
      address.autocomplete = 'off'; address.spellcheck = false;
      address.placeholder = 'Start typing a New York City address';
      address.setAttribute('role', 'combobox');
      address.setAttribute('aria-autocomplete', 'list');
      address.setAttribute('aria-expanded', 'false');
      const suggestions = el('ul', 'modeling-suggestions');
      suggestions.id = 'modeling-address-options';
      suggestions.setAttribute('role', 'listbox');
      suggestions.setAttribute('aria-label', 'New York City addresses');
      suggestions.hidden = true;
      address.setAttribute('aria-controls', suggestions.id);
      const addressNote = el('p', 'modeling-address-note', 'Pick the address from the list so the model links to its parcel, with the city property and zoning records behind it.');
      addressLabel.classList.add('modeling-address-label');
      addressLabel.append(address, suggestions);
      addressWrap.append(addressLabel, addressNote);
      const label = el('label', '', 'Project name (optional)'), name = el('input');
      name.name = 'name'; name.maxLength = 200;
      name.autocomplete = 'off'; name.placeholder = 'e.g. Courtyard apartments';
      label.append(name);
      const submit = el('button', 'core-follow primary', 'Create model'); submit.type = 'submit'; submit.disabled = true;
      const noParcel = el('button', 'core-follow', 'Create without a parcel link'); noParcel.type = 'button'; noParcel.hidden = true;
      const cancel = el('button', 'core-follow', 'Cancel'); cancel.type = 'button';
      const status = el('div', 'core-note'); status.setAttribute('role', 'status');
      form.append(addressWrap, label, submit, noParcel, cancel);
      let verified = null, options = [], active = -1, lookupTimer, lookupSeq = 0, controller = null;
      cleanups.push(() => { clearTimeout(lookupTimer); controller?.abort(); });
      const closeSuggestions = () => { suggestions.hidden = true; address.setAttribute('aria-expanded', 'false'); address.removeAttribute('aria-activedescendant'); active = -1; };
      const markActive = () => {
        suggestions.querySelectorAll('[role="option"]').forEach((node, index) => node.setAttribute('aria-selected', String(index === active)));
        if (active >= 0) address.setAttribute('aria-activedescendant', `modeling-address-option-${active}`);
        else address.removeAttribute('aria-activedescendant');
      };
      function pick(suggestion) {
        verified = suggestion;
        address.value = suggestion.label;
        submit.disabled = false;
        noParcel.hidden = true;
        addressNote.textContent = `${suggestion.borough ? suggestion.borough + ' · ' : ''}Parcel ${suggestion.bbl}. The model starts linked to this lot and its city records.`;
        closeSuggestions();
        name.focus();
      }
      const showSuggestions = () => {
        suggestions.replaceChildren(...options.map((suggestion, index) => {
          const item = el('li', 'modeling-suggestion');
          item.id = `modeling-address-option-${index}`;
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', 'false');
          item.append(el('span', 'modeling-suggestion-label', suggestion.label));
          item.append(el('span', 'modeling-suggestion-meta', [suggestion.borough, suggestion.postalcode, `BBL ${suggestion.bbl}`].filter(Boolean).join(' · ')));
          item.addEventListener('pointerdown', event => event.preventDefault());
          item.addEventListener('click', () => pick(suggestion));
          return item;
        }));
        suggestions.hidden = !options.length;
        address.setAttribute('aria-expanded', String(!suggestions.hidden));
        active = options.length ? 0 : -1;
        markActive();
      };
      address.addEventListener('input', () => {
        if (verified && address.value !== verified.label) {
          verified = null;
          submit.disabled = true;
          addressNote.textContent = 'Pick the address from the list so the model links to its parcel, with the city property and zoning records behind it.';
        }
        noParcel.hidden = true;
        const text = address.value.trim();
        const seq = ++lookupSeq;
        controller?.abort();
        clearTimeout(lookupTimer);
        if (text.length < 3) { options = []; closeSuggestions(); return; }
        lookupTimer = setTimeout(async () => {
          controller = new AbortController();
          try {
            options = await suggest(text, { signal: controller.signal });
            if (visit !== generation || seq !== lookupSeq) return;
            if (options.length) showSuggestions();
            else {
              closeSuggestions();
              addressNote.textContent = 'No New York City address matches that yet. Check the spelling, or create the model without a parcel link: Arosa will have no parcel or zoning records behind it until the address resolves.';
              noParcel.hidden = false;
            }
          } catch {
            if (visit !== generation || seq !== lookupSeq) return;
            options = []; closeSuggestions();
            addressNote.textContent = 'The New York City address directory is unavailable right now. You can create the model without a parcel link and add the address again later.';
            noParcel.hidden = false;
          }
        }, 200);
      });
      address.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (!options.length) return;
          event.preventDefault();
          if (suggestions.hidden) { suggestions.hidden = false; address.setAttribute('aria-expanded', 'true'); }
          active = (active + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
          markActive();
        } else if (event.key === 'Enter' && !suggestions.hidden && active >= 0) {
          event.preventDefault();
          pick(options[active]);
        } else if (event.key === 'Escape') closeSuggestions();
      });
      address.addEventListener('blur', closeSuggestions);
      create.addEventListener('click', () => {
        form.hidden = false; create.hidden = true; create.setAttribute('aria-expanded', 'true'); address.focus();
      });
      cancel.addEventListener('click', () => {
        form.hidden = true; create.hidden = false; create.setAttribute('aria-expanded', 'false'); create.focus();
      });
      async function createModel(useVerified) {
        const choice = useVerified ? verified : null;
        submit.disabled = true; noParcel.disabled = true; status.textContent = 'Creating model…';
        try {
          const model = await postChat('/projects', { workflow: 'modeling', address: choice ? choice.label : address.value.trim(), bbl: choice?.bbl || null, title: name.value.trim() || (choice ? choice.label : address.value.trim()) });
          if (visit === generation) navigate(`${routePath({ view: 'plan', projectId: model.id })}?view=massing`);
        } catch (error) {
          if (visit === generation) { status.replaceChildren(failLine(error.message)); submit.disabled = !verified; noParcel.disabled = false; }
        }
      }
      form.addEventListener('submit', event => { event.preventDefault(); if (verified) void createModel(true); });
      noParcel.addEventListener('click', () => void createModel(false));
      function projectList() {
        const container = el('div');
        const searchLabel = el('label', 'modeling-search', 'Search models and plans'), search = el('input');
        search.type = 'search'; searchLabel.append(search);
        const list = el('div', 'modeling-list'); list.id = 'modeling-projects';
        const listStatus = el('div', 'core-note'); listStatus.setAttribute('role', 'status');
        const more = el('button', 'core-follow', 'Load more'); more.type = 'button'; more.hidden = true;
        more.setAttribute('aria-controls', 'modeling-projects');
        let request = 0, cursor = null, timer;
        cleanups.push(() => clearTimeout(timer));
        async function load(append = false) {
          if (visit !== generation) return;
          const call = ++request;
          list.setAttribute('aria-busy', 'true'); more.disabled = true;
          const params = new URLSearchParams({ modelingLibrary: 'true', q: search.value.trim() });
          if (append) params.set('cursor', cursor);
          try {
            const data = await chatRequest('/projects?' + params);
            if (visit !== generation || call !== request) return;
            if (!append) list.replaceChildren();
            for (const project of data.projects) {
              const link = el('a', 'modeling-row');
              link.href = link.dataset.route = routePath({ view: 'plan', projectId: project.id });
              const title = el('span', 'modeling-row-main');
              title.append(el('strong', 'modeling-row-title', project.title));
              if (project.modeling === false) title.append(el('span', 'modeling-row-origin', 'From underwriting'));
              link.append(title);
              const date = fmtDate(project.updated);
              if (date) link.append(el('span', 'modeling-row-date', `Updated ${date}`));
              list.append(link);
            }
            if (!data.projects.length && !append) list.append(el('p', 'core-empty', search.value.trim() ? 'No models or plans match that search.' : 'Start a model to draw a floor plan, upload a drawing or explore a building in 3D.'));
            cursor = data.nextCursor; more.hidden = !cursor; listStatus.textContent = '';
          } catch (error) {
            if (visit === generation && call === request) {
              const retry = el('button', 'core-follow', 'Retry'); retry.type = 'button';
              retry.addEventListener('click', () => void load(append));
              listStatus.replaceChildren(failLine(error.message, [retry]));
            }
          } finally {
            if (visit === generation && call === request) { list.setAttribute('aria-busy', 'false'); more.disabled = false; }
          }
        }
        search.addEventListener('input', () => { ++request; cursor = null; more.hidden = true; more.disabled = true; clearTimeout(timer); timer = setTimeout(() => void load(), 200); });
        more.addEventListener('click', () => void load(true));
        container.append(searchLabel, listStatus, list, more);
        return { container, load };
      }
      const library = projectList();
      page.append(head, el('p', 'core-note', 'Floor plans, building models and walkthroughs.'), form, status, library.container);
      root.replaceChildren(page);
      void library.load();
    },
  };
}
