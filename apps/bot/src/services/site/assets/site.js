/*
 * Script commun des sites communautaires Kotbo.
 *
 * Le rendu serveur ne connaît jamais le visiteur (le cookie de session vit sur
 * l'hôte de l'API). Ce script :
 *  - demande à l'API qui est connecté, et affiche la connexion ou « Mon espace » ;
 *  - recharge avec cette identité les blocs qui en dépendent (data-viewer-aware),
 *    et périodiquement ceux qui bougent en direct (data-live) ;
 *  - charge le contenu des pages réservées (data-restricted) ;
 *  - envoie formulaires et actions, puis recharge le bloc concerné.
 *
 * Aucun gestionnaire en ligne : la CSP du site les interdit.
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var API = root.getAttribute('data-api') || '';
  var SITE = root.getAttribute('data-site') || '';
  var GUILD = root.getAttribute('data-guild') || '';
  var PAGE = root.getAttribute('data-page') || '';
  var SITE_API = API + '/api/site/' + SITE;
  var T = {};
  try {
    T = JSON.parse((document.getElementById('site-i18n') || {}).textContent || '{}');
  } catch (e) {
    T = {};
  }

  var viewer = null;
  var viewerLoaded = false;
  var agent = null;
  var agentTimer = null;

  // ─── Utilitaires ────────────────────────────────────────────────────────

  function request(method, url, body) {
    var init = { method: method, credentials: 'include', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!res.ok) {
            var err = new Error((data && data.error) || T.error || 'Erreur');
            err.status = res.status;
            err.data = data;
            throw err;
          }
          return data;
        });
    });
  }

  function loginUrl() {
    return API + '/api/auth/discord/login?returnTo=' + encodeURIComponent(location.pathname + location.search + location.hash);
  }

  function goLogin() {
    location.href = loginUrl();
  }

  function setStatus(form, message, kind) {
    var status = form.querySelector('.form-status');
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('is-error', kind === 'error');
    status.classList.toggle('is-ok', kind === 'ok');
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        node.setAttribute(k, attrs[k]);
      });
    }
    if (text) node.textContent = text;
    return node;
  }

  /** Remplace un nœud par du HTML rendu par le serveur du site (jamais par une donnée brute). */
  function replaceWithHtml(node, html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    var fresh = tpl.content.firstElementChild;
    if (!fresh) {
      node.remove();
      return null;
    }
    node.replaceWith(fresh);
    return fresh;
  }

  // ─── Menu mobile ───────────────────────────────────────────────────────

  document.querySelectorAll('[data-menu-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = document.getElementById(btn.getAttribute('aria-controls'));
      if (!target) return;
      var open = target.getAttribute('data-open') === '1';
      target.setAttribute('data-open', open ? '0' : '1');
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
  });

  // Un sous-menu ouvert se referme quand on clique ailleurs.
  document.addEventListener('click', function (event) {
    document.querySelectorAll('.nav details[open]').forEach(function (d) {
      if (!d.contains(event.target)) d.removeAttribute('open');
    });
  });

  // ─── Visiteur ──────────────────────────────────────────────────────────

  function renderViewerSlots() {
    document.querySelectorAll('[data-viewer-slot]').forEach(function (slot) {
      slot.textContent = '';
      if (viewer) {
        var chip = el('a', { class: 'viewer-chip', href: root.getAttribute('data-base') + '/me' });
        if (viewer.avatarUrl) {
          chip.appendChild(el('img', { class: 'avatar avatar-sm', src: viewer.avatarUrl, alt: '', referrerpolicy: 'no-referrer' }));
        }
        chip.appendChild(el('span', null, viewer.displayName));
        slot.appendChild(chip);
      } else {
        var login = el('a', { class: 'btn btn-primary btn-sm', href: loginUrl() }, T.login || 'Login');
        slot.appendChild(login);
      }
    });
    document.querySelectorAll('[data-login]').forEach(function (a) {
      a.setAttribute('href', loginUrl());
    });
    document.querySelectorAll('[data-login-hint]').forEach(function (hint) {
      hint.hidden = Boolean(viewer);
    });
  }

  function loadViewer() {
    return request('GET', SITE_API + '/viewer')
      .then(function (data) {
        viewer = data.viewer || null;
        agent = data.agent || null;
      })
      .catch(function () {
        viewer = null;
      })
      .then(function () {
        viewerLoaded = true;
        renderViewerSlots();
        renderAgentBanner();
      });
  }

  // ─── Agent MCP (gérants seulement) ─────────────────────────────────────

  /** Bandeau « un agent modifie ce site », avec de quoi l'arrêter. */
  function renderAgentBanner() {
    var existing = document.getElementById('kotbo-agent');
    if (!agent || !agent.active) {
      if (existing) existing.remove();
      if (agentTimer) clearInterval(agentTimer);
      agentTimer = null;
      return;
    }
    var banner = existing || el('div', { id: 'kotbo-agent', class: 'kotbo-agent', role: 'status' });
    banner.textContent = '';
    banner.appendChild(el('span', { class: 'kotbo-agent-dot', 'aria-hidden': 'true' }));
    banner.appendChild(el('span', null, (T.agentActive || '').replace('{key}', agent.keyName || 'MCP') + (agent.activity ? ' — ' + agent.activity : '')));
    var stop = el('button', { type: 'button', class: 'kotbo-agent-stop' }, T.agentInterrupt);
    stop.addEventListener('click', function () {
      stop.disabled = true;
      request('POST', SITE_API + '/agent/interrupt', {})
        .then(function (data) {
          agent = data.agent || null;
          renderAgentBanner();
          var note = el('div', { class: 'kotbo-agent', role: 'status' }, T.agentInterrupted);
          document.body.appendChild(note);
          setTimeout(function () { note.remove(); }, 4000);
        })
        .catch(function (err) {
          stop.disabled = false;
          banner.appendChild(el('span', { class: 'kotbo-agent-error' }, err.message));
        });
    });
    banner.appendChild(stop);
    if (!existing) document.body.appendChild(banner);
    if (!agentTimer) {
      agentTimer = setInterval(function () {
        request('GET', SITE_API + '/viewer')
          .then(function (data) {
            agent = data.agent || null;
            renderAgentBanner();
          })
          .catch(function () {});
      }, 15000);
    }
  }

  // ─── Blocs ─────────────────────────────────────────────────────────────

  function refreshBlock(section) {
    var ref = section.getAttribute('data-block');
    if (!ref) return Promise.resolve(null);
    var parts = ref.split(':');
    return request('GET', SITE_API + '/blocks/' + encodeURIComponent(parts[0]) + '/' + encodeURIComponent(parts[1]))
      .then(function (data) {
        if (typeof data.html !== 'string') return null;
        var fresh = replaceWithHtml(section, data.html);
        if (fresh) bindLive(fresh);
        return fresh;
      })
      .catch(function () {
        return null;
      });
  }

  function bindLive(section) {
    var seconds = Number(section.getAttribute('data-live'));
    if (!seconds || section.__liveTimer) return;
    section.__liveTimer = setInterval(function () {
      if (document.hidden || !document.body.contains(section)) {
        if (!document.body.contains(section)) clearInterval(section.__liveTimer);
        return;
      }
      clearInterval(section.__liveTimer);
      refreshBlock(section);
    }, Math.max(15, seconds) * 1000);
  }

  function blockOf(node) {
    return node.closest('section.mod[data-block]');
  }

  // ─── Pages réservées ───────────────────────────────────────────────────

  function loadRestricted() {
    var holder = document.querySelector('[data-restricted]');
    if (!holder) return;
    var pageId = holder.getAttribute('data-restricted');
    request('GET', SITE_API + '/pages/' + encodeURIComponent(pageId) + '/content')
      .then(function (data) {
        holder.innerHTML = data.html;
        holder.removeAttribute('data-restricted');
        holder.querySelectorAll('section.mod[data-live]').forEach(bindLive);
      })
      .catch(function (err) {
        var message = holder.querySelector('[data-restricted-message]');
        if (err.status === 401) {
          holder.querySelectorAll('[data-restricted-login]').forEach(function (n) {
            n.hidden = false;
          });
        } else if (message) {
          message.textContent = err.status === 403 ? T.restrictedDenied : T.error;
        }
      });
  }

  // ─── Actions (boutons data-action) ─────────────────────────────────────

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-action]');
    if (!button) return;
    event.preventDefault();
    if (button.getAttribute('data-requires-login') === '1' && !viewer) {
      goLogin();
      return;
    }
    var action = button.getAttribute('data-action');
    var payload = { id: button.getAttribute('data-id') };
    if (button.hasAttribute('data-dir')) payload.dir = button.getAttribute('data-dir');
    button.disabled = true;
    request('POST', SITE_API + '/actions/' + encodeURIComponent(action), payload)
      .then(function (data) {
        var section = blockOf(button);
        if (data && data.message) alertInline(button, data.message, 'ok');
        if (section) return refreshBlock(section);
        return null;
      })
      .catch(function (err) {
        if (err.status === 401) return goLogin();
        alertInline(button, err.message, 'error');
        button.disabled = false;
      });
  });

  function alertInline(anchor, message, kind) {
    var host = anchor.closest('.card-body, .suggest-body, .mod') || anchor.parentElement;
    if (!host) return;
    var note = host.querySelector(':scope > .inline-status');
    if (!note) {
      note = el('p', { class: 'form-status inline-status', role: 'status' });
      host.appendChild(note);
    }
    note.textContent = message;
    note.classList.toggle('is-error', kind === 'error');
    note.classList.toggle('is-ok', kind === 'ok');
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest('a[data-login]');
    if (!link) return;
    event.preventDefault();
    goLogin();
  });

  // ─── Formulaires ───────────────────────────────────────────────────────

  /** Réponses d'un formulaire `data-form` : une valeur par champ, cases jointes. */
  function collectFormData(form) {
    var data = {};
    var missing = null;
    form.querySelectorAll('input, select, textarea').forEach(function (input) {
      if (!input.name || input.type === 'submit') return;
      if (input.type === 'checkbox') {
        if (input.checked) data[input.name] = data[input.name] ? data[input.name] + ', ' + input.value : input.value;
        return;
      }
      if (input.type === 'radio') {
        if (input.checked) data[input.name] = input.value;
        return;
      }
      data[input.name] = input.value.trim();
      if (input.required && !data[input.name] && !missing) missing = input;
    });
    form.querySelectorAll('fieldset[data-required]').forEach(function (fs) {
      var name = (fs.querySelector('input') || {}).name;
      if (name && !data[name] && !missing) missing = fs.querySelector('input');
    });
    form.querySelectorAll('input[type=radio][required]').forEach(function (r) {
      if (!data[r.name] && !missing) missing = r;
    });
    return { data: data, missing: missing };
  }

  function submitWith(form, promiseFactory, onDone) {
    var button = form.querySelector('[type=submit]');
    if (button) button.disabled = true;
    setStatus(form, T.loading, null);
    return promiseFactory()
      .then(function (result) {
        onDone(result);
      })
      .catch(function (err) {
        if (err.status === 401) {
          setStatus(form, T.formLogin, 'error');
          goLogin();
          return;
        }
        setStatus(form, err.message, 'error');
      })
      .then(function () {
        if (button) button.disabled = false;
      });
  }

  var FORM_HANDLERS = {
    // Formulaire Kotbo (recrutement, inscription, formulaire libre).
    'data-form': function (form) {
      var collected = collectFormData(form);
      if (collected.missing) {
        setStatus(form, T.formRequired, 'error');
        collected.missing.focus();
        return;
      }
      var id = form.getAttribute('data-form');
      var body = { data: collected.data };
      if (form.getAttribute('data-event')) body.eventId = form.getAttribute('data-event');
      submitWith(
        form,
        function () {
          return request('POST', API + '/api/public/custom-forms/' + encodeURIComponent(id) + '/submit', body);
        },
        function () {
          form.reset();
          setStatus(form, T.formSent, 'ok');
        },
      );
    },
    'data-suggest': function (form) {
      var content = (form.querySelector('textarea') || {}).value || '';
      if (!content.trim()) return;
      submitWith(
        form,
        function () {
          return request('POST', SITE_API + '/actions/suggestion-create', { content: content.trim() });
        },
        function () {
          form.reset();
          setStatus(form, T.suggestionSent, 'ok');
          var section = blockOf(form);
          if (section) setTimeout(function () { refreshBlock(section); }, 800);
        },
      );
    },
    'data-appeal-form': function (form) {
      var collected = collectFormData(form);
      var sanctionIds = [];
      var statements = {};
      form.querySelectorAll('input[name="__sanction"]:checked').forEach(function (c) {
        sanctionIds.push(c.value);
      });
      form.querySelectorAll('textarea[data-statement]').forEach(function (t) {
        if (t.value.trim()) statements[t.getAttribute('data-statement')] = t.value.trim();
      });
      delete collected.data.__sanction;
      Object.keys(collected.data).forEach(function (k) {
        if (k.indexOf('__statement_') === 0) delete collected.data[k];
      });
      if (collected.missing && collected.missing.name.indexOf('__') !== 0) {
        setStatus(form, T.formRequired, 'error');
        collected.missing.focus();
        return;
      }
      submitWith(
        form,
        function () {
          return request('POST', API + '/api/public/appeal/' + encodeURIComponent(GUILD) + '/submit', {
            data: collected.data,
            sanctionIds: sanctionIds,
            statements: statements,
          });
        },
        function () {
          var section = blockOf(form);
          if (section) refreshBlock(section);
        },
      );
    },
    'data-appeal-info': function (form) {
      var response = (form.querySelector('textarea') || {}).value || '';
      if (!response.trim()) return;
      submitWith(
        form,
        function () {
          return request('POST', API + '/api/public/appeal/' + encodeURIComponent(GUILD) + '/info-response', { response: response.trim() });
        },
        function () {
          var section = blockOf(form);
          if (section) refreshBlock(section);
        },
      );
    },
    'data-ticket-new': function (form) {
      var collected = collectFormData(form);
      if (collected.missing) {
        setStatus(form, T.formRequired, 'error');
        collected.missing.focus();
        return;
      }
      submitWith(
        form,
        function () {
          return request('POST', SITE_API + '/tickets', collected.data);
        },
        function () {
          var section = blockOf(form);
          if (section) refreshBlock(section);
        },
      );
    },
    'data-ticket-reply': function (form) {
      var content = (form.querySelector('textarea') || {}).value || '';
      if (!content.trim()) return;
      var id = form.getAttribute('data-ticket-reply');
      submitWith(
        form,
        function () {
          return request('POST', SITE_API + '/tickets/' + encodeURIComponent(id) + '/messages', { content: content.trim() });
        },
        function () {
          var section = blockOf(form);
          if (section) refreshBlock(section);
        },
      );
    },
    'data-comment': function (form) {
      var content = (form.querySelector('textarea') || {}).value || '';
      if (!content.trim()) return;
      var pageId = form.getAttribute('data-comment');
      submitWith(
        form,
        function () {
          return request('POST', SITE_API + '/pages/' + encodeURIComponent(pageId) + '/comments', { content: content.trim() });
        },
        function (result) {
          form.reset();
          if (result && result.status === 'PENDING') {
            setStatus(form, T.commentPending, 'ok');
          } else {
            setStatus(form, '', null);
            reloadComments(pageId);
          }
        },
      );
    },
  };

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    var key = Object.keys(FORM_HANDLERS).find(function (attr) {
      return form.hasAttribute(attr);
    });
    if (!key) return;
    event.preventDefault();
    if (form.getAttribute('data-requires-login') === '1' && !viewer) {
      setStatus(form, T.formLogin, 'error');
      goLogin();
      return;
    }
    FORM_HANDLERS[key](form);
  });

  // ─── Commentaires ──────────────────────────────────────────────────────

  function reloadComments(pageId) {
    var holder = document.querySelector('[data-comments="' + pageId + '"]');
    if (!holder) return;
    request('GET', SITE_API + '/pages/' + encodeURIComponent(pageId) + '/comments')
      .then(function (data) {
        if (typeof data.html === 'string') replaceWithHtml(holder, data.html);
      })
      .catch(function () {});
  }

  // ─── Signalement ───────────────────────────────────────────────────────

  var dialog = document.getElementById('kotbo-report');
  document.querySelectorAll('[data-report-open]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
    });
  });
  if (dialog) {
    var reportForm = dialog.querySelector('[data-report-form]');
    dialog.querySelector('[data-report-cancel]').addEventListener('click', function () {
      dialog.close();
    });
    reportForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var reason = reportForm.querySelector('[name=reason]').value;
      var details = reportForm.querySelector('[name=details]').value;
      submitWith(
        reportForm,
        function () {
          return request('POST', SITE_API + '/report', { reason: reason, details: details, path: location.pathname, pageId: PAGE || null });
        },
        function () {
          reportForm.reset();
          setStatus(reportForm, T.reportSent, 'ok');
          setTimeout(function () {
            dialog.close();
            setStatus(reportForm, '', null);
          }, 2200);
        },
      );
    });
  }

  // ─── Copier le lien ────────────────────────────────────────────────────

  document.addEventListener('click', function (event) {
    var btn = event.target.closest('[data-copy]');
    if (!btn || !navigator.clipboard) return;
    event.preventDefault();
    var url = new URL(btn.getAttribute('data-copy') || location.href, location.href).toString();
    navigator.clipboard.writeText(url).then(function () {
      var label = btn.textContent;
      btn.textContent = T.linkCopied;
      setTimeout(function () {
        btn.textContent = label;
      }, 1600);
    });
  });

  // ─── Démarrage ─────────────────────────────────────────────────────────

  document.querySelectorAll('section.mod[data-live]').forEach(bindLive);

  loadViewer().then(function () {
    loadRestricted();
    // Les blocs qui dépendent du visiteur ne changent que s'il est connecté :
    // pour un anonyme, le rendu serveur est déjà le bon, sauf l'appel et le
    // ticket, qui doivent proposer la connexion.
    document.querySelectorAll('section.mod[data-viewer-aware]').forEach(function (section) {
      var needsViewer = section.querySelector('[data-appeal], [data-ticket], [data-profile]');
      if (viewer || needsViewer) refreshBlock(section);
    });
  });

  // Le statut est exposé pour le débogage, pas pour d'autres scripts.
  window.__kotboSite = {
    get viewer() {
      return viewer;
    },
    get ready() {
      return viewerLoaded;
    },
  };
})();
