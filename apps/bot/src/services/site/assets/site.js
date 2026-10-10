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

  // ─── Mode clair / sombre ───────────────────────────────────────────────
  // Le mode par défaut vient du thème (`data-default-mode`, éventuellement
  // `auto`) ; le choix du visiteur est retenu par site, et appliqué avant le
  // premier rendu par le script en tête de page.

  var modeKey = 'kotbo-site-mode:' + root.getAttribute('data-site');
  var systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function effectiveMode() {
    var chosen = root.getAttribute('data-mode');
    if (chosen === 'light' || chosen === 'dark') return chosen;
    var fallback = root.getAttribute('data-default-mode') || 'auto';
    if (fallback === 'auto') return systemDark && systemDark.matches ? 'dark' : 'light';
    return fallback;
  }

  function syncEffectiveMode() {
    root.setAttribute('data-effective', effectiveMode());
  }

  document.querySelectorAll('[data-mode-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var next = effectiveMode() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-mode', next);
      try {
        localStorage.setItem(modeKey, next);
      } catch (e) {
        // Stockage indisponible (navigation privée) : le choix vaut pour la page.
      }
      syncEffectiveMode();
    });
  });
  if (systemDark && systemDark.addEventListener) systemDark.addEventListener('change', syncEffectiveMode);
  syncEffectiveMode();

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
        pendingReward = data.reward || null;
      })
      .catch(function () {
        viewer = null;
      })
      .then(function () {
        viewerLoaded = true;
        renderViewerSlots();
        applyForumViewer();
        renderAgentBanner();
      });
  }

  // ─── Récompenses de l'activité ─────────────────────────────────────────

  var pendingReward = null;

  /** Petit encart en bas de page : pièces, XP, série. */
  function showReward(reward) {
    if (!reward || (!reward.coins && !reward.xp)) return;
    var parts = [];
    if (reward.coins) parts.push((T.rewardCoins || '+{count}').replace('{count}', reward.coins));
    if (reward.xp) parts.push((T.rewardXp || '+{count} XP').replace('{count}', reward.xp));
    var title = reward.kind === 'DAILY' ? T.rewardDaily : reward.kind === 'READ' ? T.rewardRead : T.rewardOther;
    var note = el('div', { class: 'reward-toast', role: 'status' });
    note.appendChild(el('strong', null, title || ''));
    note.appendChild(el('span', null, parts.join(' · ')));
    if (reward.streak && reward.streak > 1) note.appendChild(el('span', { class: 'reward-streak' }, (T.rewardStreak || '').replace('{count}', reward.streak)));
    document.body.appendChild(note);
    setTimeout(function () {
      note.classList.add('is-leaving');
      setTimeout(function () { note.remove(); }, 400);
    }, 5000);
  }

  /**
   * Page lue jusqu'au bout : le repère de fin est visible après au moins
   * 20 secondes sur la page. Une seule fois par page et par visite.
   */
  function trackReading() {
    var mark = document.querySelector('[data-read-page]');
    if (!mark || !viewer || !viewer.isMember || !('IntersectionObserver' in window)) return;
    var started = Date.now();
    var sent = false;
    var observer = new IntersectionObserver(function (entries) {
      if (sent || !entries.some(function (e) { return e.isIntersecting; })) return;
      var wait = Math.max(0, 20000 - (Date.now() - started));
      setTimeout(function () {
        if (sent) return;
        sent = true;
        observer.disconnect();
        request('POST', SITE_API + '/read/' + encodeURIComponent(mark.getAttribute('data-read-page')), {})
          .then(function (data) { showReward(data.reward); })
          .catch(function () {});
      }, wait);
    });
    observer.observe(mark);
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
        if (live.connected) return;
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
      if (document.hidden || !document.body.contains(section) || signalledByLive(section)) {
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
    // Achat à la boutique : cadeau, code promo, message au staff.
    'data-shop-buy': function (form) {
      var collected = collectFormData(form);
      if (collected.missing) {
        setStatus(form, T.formRequired, 'error');
        collected.missing.focus();
        return;
      }
      var payload = { id: form.getAttribute('data-shop-buy') };
      Object.keys(collected.data).forEach(function (k) {
        payload[k] = collected.data[k];
      });
      submitWith(
        form,
        function () {
          return request('POST', SITE_API + '/actions/shop-buy', payload);
        },
        function (data) {
          setStatus(form, (data && data.message) || T.formSent, 'ok');
          var section = blockOf(form);
          if (section) setTimeout(function () { refreshBlock(section); }, 1800);
        },
      );
    },
    // Forum : nouveau sujet (ouvert aussitôt) et réponse (dernière page rechargée).
    'data-forum-topic': function (form) {
      var collected = collectFormData(form);
      if (collected.missing) {
        setStatus(form, T.formRequired, 'error');
        collected.missing.focus();
        return;
      }
      submitWith(
        form,
        function () {
          return request('POST', SITE_API + '/forum/categories/' + encodeURIComponent(form.getAttribute('data-forum-topic')) + '/topics', collected.data);
        },
        function (data) {
          if (data && data.url) location.href = data.url;
        },
      );
    },
    'data-forum-reply': function (form) {
      var collected = collectFormData(form);
      if (collected.missing) {
        setStatus(form, T.formRequired, 'error');
        collected.missing.focus();
        return;
      }
      var topicId = form.getAttribute('data-forum-reply');
      submitWith(
        form,
        function () {
          return request('POST', SITE_API + '/forum/topics/' + encodeURIComponent(topicId) + '/posts', { content: collected.data.content });
        },
        function (data) {
          form.reset();
          setStatus(form, '', null);
          var holder = document.querySelector('[data-forum-live="' + topicId + '"]');
          if (holder && data && data.pages) holder.setAttribute('data-page', String(data.pages));
          reloadForum(topicId, true);
        },
      );
    },
    'data-member-settings': function (form) {
      var notifications = {};
      form.querySelectorAll('input[name^="notify_"]').forEach(function (input) {
        notifications[input.name.slice(7)] = input.checked;
      });
      var visible = form.querySelector('input[name="profileVisible"]');
      submitWith(
        form,
        function () {
          return request('POST', SITE_API + '/me/settings', { profileHidden: visible ? !visible.checked : undefined, notifications: notifications });
        },
        function (data) {
          setStatus(form, (data && data.message) || T.formSent, 'ok');
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

  // ─── Forum ─────────────────────────────────────────────────────────────

  /** Boutons et formulaires réservés : son propre message, le staff, un sujet ouvert. */
  function applyForumViewer() {
    document.querySelectorAll('[data-forum-delete]').forEach(function (button) {
      button.hidden = !viewer || !(viewer.isStaff || viewer.userId === button.getAttribute('data-author'));
    });
    document.querySelectorAll('[data-staff-only]').forEach(function (node) {
      node.hidden = !(viewer && viewer.isStaff);
    });
    document.querySelectorAll('form[data-locked]').forEach(function (form) {
      form.hidden = !(viewer && viewer.isStaff);
    });
  }

  function reloadForum(id, scroll) {
    document.querySelectorAll('[data-forum-live="' + id + '"]').forEach(function (holder) {
      var kind = holder.getAttribute('data-forum-kind');
      var page = holder.getAttribute('data-page') || '1';
      request('GET', SITE_API + '/forum/fragment/' + encodeURIComponent(kind) + '/' + encodeURIComponent(id) + '?page=' + encodeURIComponent(page))
        .then(function (data) {
          if (typeof data.html !== 'string') return;
          holder.innerHTML = data.html;
          if (data.pages) holder.setAttribute('data-pages', String(data.pages));
          applyForumViewer();
          if (scroll) {
            var last = holder.querySelector('.forum-post:last-of-type');
            if (last) last.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        })
        .catch(function () {});
    });
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-forum-delete]');
    if (!button) return;
    event.preventDefault();
    if (!window.confirm(T.forumDeleteConfirm)) return;
    var holder = button.closest('[data-forum-live]');
    button.disabled = true;
    request('DELETE', SITE_API + '/forum/posts/' + encodeURIComponent(button.getAttribute('data-forum-delete')))
      .then(function () {
        if (holder) reloadForum(holder.getAttribute('data-forum-live'));
      })
      .catch(function (err) {
        alertInline(button, err.message, 'error');
        button.disabled = false;
      });
  });

  // Prix recalculé avec le code promo saisi, sans rien acheter.
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-shop-quote]');
    if (!button) return;
    event.preventDefault();
    var form = button.closest('form[data-shop-buy]');
    if (!form) return;
    if (!viewer) {
      goLogin();
      return;
    }
    var collected = collectFormData(form);
    var payload = { id: form.getAttribute('data-shop-buy'), code: collected.data.code || '', recipient: collected.data.recipient || '' };
    button.disabled = true;
    request('POST', SITE_API + '/actions/shop-quote', payload)
      .then(function (data) {
        var total = form.querySelector('[data-shop-total]');
        if (total && data && data.total) total.textContent = data.total;
        setStatus(form, (data && data.message) || '', 'ok');
      })
      .catch(function (err) {
        if (err.status === 401) return goLogin();
        setStatus(form, err.message, 'error');
      })
      .then(function () {
        button.disabled = false;
      });
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

  // ─── Temps réel ────────────────────────────────────────────────────────
  // Le socket ne porte que des signaux (« ce bloc a changé ») ; le contenu est
  // relu par les routes HTTP habituelles. Sans socket, le sondage des blocs en
  // direct reste en place.

  var live = { socket: null, connected: false, retry: 0, channels: [] };
  /** Blocs dont le rafraîchissement vient du socket quand il est ouvert. */
  var SIGNALLED = { voice: true, channelFeed: true, giveaways: true, ticket: true, suggestions: true, events: true, marketplace: true };

  function liveChannels() {
    var channels = {};
    document.querySelectorAll('section.mod[data-module]').forEach(function (section) {
      channels['module:' + section.getAttribute('data-module')] = true;
    });
    document.querySelectorAll('[data-comments]').forEach(function (holder) {
      channels['comments:' + holder.getAttribute('data-comments')] = true;
    });
    document.querySelectorAll('[data-forum-live]').forEach(function (holder) {
      channels['forum:' + holder.getAttribute('data-forum-live')] = true;
    });
    if (viewer) {
      channels['user:' + viewer.userId] = true;
      if (viewer.canManageSite) channels.agent = true;
    }
    return Object.keys(channels).slice(0, 40);
  }

  function onSignal(channel) {
    if (channel === 'agent') {
      request('GET', SITE_API + '/viewer')
        .then(function (data) {
          agent = data.agent || null;
          renderAgentBanner();
        })
        .catch(function () {});
      return;
    }
    if (channel.indexOf('module:') === 0) {
      var key = channel.slice(7);
      document.querySelectorAll('section.mod[data-module="' + key + '"]').forEach(function (section) {
        // Étalé : tous les visiteurs ne relisent pas le bloc à la même milliseconde.
        setTimeout(function () { refreshBlock(section); }, Math.floor(Math.random() * 800));
      });
      return;
    }
    if (channel.indexOf('comments:') === 0) {
      reloadComments(channel.slice(9));
      return;
    }
    if (channel.indexOf('forum:') === 0) {
      reloadForum(channel.slice(6));
      return;
    }
    if (channel.indexOf('user:') === 0) {
      document.querySelectorAll('section.mod[data-module="ticket"], section.mod[data-module^="member"]').forEach(function (section) {
        refreshBlock(section);
      });
    }
  }

  function connectLive() {
    if (!('WebSocket' in window) || !API || !SITE) return;
    var url;
    try {
      url = new URL('/api/site/live/' + encodeURIComponent(SITE), API);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    } catch (e) {
      return;
    }
    var socket = new WebSocket(url.toString());
    live.socket = socket;
    socket.addEventListener('message', function (event) {
      var data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (data.type === 'site_live_ready') {
        live.connected = true;
        live.retry = 0;
        live.channels = liveChannels();
        socket.send(JSON.stringify({ type: 'subscribe', channels: live.channels }));
      } else if (data.type === 'site_signal' && typeof data.channel === 'string') {
        onSignal(data.channel);
      }
    });
    socket.addEventListener('close', function () {
      live.connected = false;
      live.socket = null;
      // Reprise progressive : 2 s, 4 s, 8 s… jusqu'à une minute.
      var delay = Math.min(60000, 2000 * Math.pow(2, live.retry));
      live.retry += 1;
      setTimeout(connectLive, delay);
    });
  }

  /** Sondage d'un bloc en direct : inutile tant que le socket le signale. */
  function signalledByLive(section) {
    return live.connected && SIGNALLED[section.getAttribute('data-module')] === true;
  }

  // ─── Démarrage ─────────────────────────────────────────────────────────

  document.querySelectorAll('section.mod[data-live]').forEach(bindLive);

  loadViewer().then(function () {
    loadRestricted();
    // Les blocs qui dépendent du visiteur ne changent que s'il est connecté :
    // pour un anonyme, le rendu serveur est déjà le bon, sauf l'appel et le
    // ticket, qui doivent proposer la connexion.
    document.querySelectorAll('section.mod[data-viewer-aware]').forEach(function (section) {
      var needsViewer = section.querySelector('[data-appeal], [data-ticket], [data-profile], [data-member-block]');
      if (viewer || needsViewer) refreshBlock(section);
    });
    showReward(pendingReward);
    trackReading();
    connectLive();
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
