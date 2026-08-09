/**
 * Shared JS for all webview panels.
 * Provides custom select/combobox initialization, dropdown close handler,
 * and a client-side escapeHtml utility.
 *
 * Usage: Include the returned string in a <script> tag before panel-specific JS.
 * Then call initCustomSelects() and/or initCustomComboboxes() from your IIFE.
 */
export function baseWebviewJs(): string {
  return `
    function escapeHtml(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function selectCustomOption(wrapper, value) {
      var hiddenInput = wrapper.querySelector('input[type="hidden"]');
      var textEl = wrapper.querySelector('.custom-select-text');
      var options = wrapper.querySelectorAll('.custom-select-option');
      for (var i = 0; i < options.length; i++) {
        options[i].classList.remove('selected');
        options[i].setAttribute('aria-selected', 'false');
        if (options[i].dataset.value === value) {
          options[i].classList.add('selected');
          options[i].setAttribute('aria-selected', 'true');
          var labelEl = options[i].querySelector('.custom-select-option-label');
          textEl.textContent = labelEl ? labelEl.textContent : options[i].textContent;
        }
      }
      hiddenInput.value = value;
      setCustomSelectOpen(wrapper, false);
      var triggerEl = wrapper.querySelector('.custom-select-trigger');
      if (triggerEl) triggerEl.focus();
      hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
      hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function setCustomSelectOpen(wrapper, open) {
      wrapper.classList.toggle('open', !!open);
      var trigger = wrapper.querySelector('.custom-select-trigger');
      if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    document.addEventListener('click', function(e) {
      if (!e.target.closest('.custom-select')) {
        var openSelects = document.querySelectorAll('.custom-select.open');
        for (var i = 0; i < openSelects.length; i++) {
          setCustomSelectOpen(openSelects[i], false);
        }
      }
      if (!e.target.closest('.custom-combobox')) {
        var openCombos = document.querySelectorAll('.custom-combobox.open');
        for (var i = 0; i < openCombos.length; i++) {
          openCombos[i].classList.remove('open');
        }
      }
    });

    function initCustomSelects(onOptionClick) {
      var customSelects = document.querySelectorAll('.custom-select');
      for (var cs = 0; cs < customSelects.length; cs++) {
        (function(wrapper) {
          var trigger = wrapper.querySelector('.custom-select-trigger');
          var dropdown = wrapper.querySelector('.custom-select-dropdown');
          // A filterable select carries a filter input at the top of its
          // dropdown. Its presence — not a class flag — is what switches this
          // wrapper into type-to-filter mode, so the two paths never diverge on
          // which is which.
          var filterInput = wrapper.querySelector('.custom-select-filter');

          function chooseOption(opt) {
            if (onOptionClick) {
              onOptionClick(wrapper, opt);
            } else {
              selectCustomOption(wrapper, opt.dataset.value);
            }
          }

          // Opening a filterable select drops focus straight into its filter box
          // (with the filter reset, so the full list shows) so the user can type
          // immediately; a plain select keeps focus on the trigger, unchanged.
          function openSelect(open) {
            var openSelects = document.querySelectorAll('.custom-select.open');
            for (var j = 0; j < openSelects.length; j++) {
              if (openSelects[j] !== wrapper) setCustomSelectOpen(openSelects[j], false);
            }
            setCustomSelectOpen(wrapper, open);
            if (open && filterInput) {
              resetFilter();
              filterInput.focus();
            }
          }

          trigger.addEventListener('click', function(e) {
            e.stopPropagation();
            openSelect(!wrapper.classList.contains('open'));
          });
          trigger.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openSelect(!wrapper.classList.contains('open'));
            } else if (e.key === 'Escape') {
              setCustomSelectOpen(wrapper, false);
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (!wrapper.classList.contains('open')) {
                openSelect(true);
                return;
              }
              // For a filterable select the arrows move the highlight from the
              // filter input (handled below); the trigger only opens it, so
              // there is no double-fire between the two handlers.
              if (filterInput) return;
              var opts = wrapper.querySelectorAll('.custom-select-option');
              var current = wrapper.querySelector('.custom-select-option.selected');
              var idx = -1;
              for (var ai = 0; ai < opts.length; ai++) {
                if (opts[ai] === current) { idx = ai; break; }
              }
              if (e.key === 'ArrowDown') { idx = Math.min(idx + 1, opts.length - 1); }
              else { idx = Math.max(idx - 1, 0); }
              chooseOption(opts[idx]);
            }
          });
          dropdown.addEventListener('click', function(e) {
            var opt = e.target.closest('.custom-select-option');
            if (!opt) return;
            chooseOption(opt);
          });

          // ── FILTERABLE BEHAVIOR ─────────────────────────────────────────────
          // Everything below is inert for a plain select (no filter input), so
          // the non-filterable path stays byte-for-byte the old one.
          function resetFilter() {}
          if (!filterInput) {
            return;
          }
          var noMatches = dropdown.querySelector('.custom-select-no-matches');

          function optionValue(opt) { return opt.dataset.value || ''; }
          function isCreateOption(opt) { return optionValue(opt).indexOf('__create__') === 0; }
          // A "real" option is one the user can pick as an actual value: not the
          // empty-value (None) sentinel, not the __create__ affordance. Matches
          // are counted over these alone, so "No matches" reflects the pickable
          // list.
          function isRealOption(opt) {
            var v = optionValue(opt);
            return v !== '' && v.indexOf('__create__') !== 0;
          }

          var hasCreateOption = false;
          var initialOpts = dropdown.querySelectorAll('.custom-select-option');
          for (var hi = 0; hi < initialOpts.length; hi++) {
            if (isCreateOption(initialOpts[hi])) { hasCreateOption = true; break; }
          }

          function highlighted() { return dropdown.querySelector('.custom-select-option.highlighted'); }
          function clearHighlight() {
            var h = highlighted();
            if (h) h.classList.remove('highlighted');
          }
          function setHighlight(opt) {
            clearHighlight();
            if (opt) {
              opt.classList.add('highlighted');
              if (opt.scrollIntoView) opt.scrollIntoView({ block: 'nearest' });
            }
          }
          function visibleOptions() {
            var out = [];
            var opts = dropdown.querySelectorAll('.custom-select-option');
            for (var vi = 0; vi < opts.length; vi++) {
              if (opts[vi].style.display !== 'none') out.push(opts[vi]);
            }
            return out;
          }

          function applyFilter() {
            var q = (filterInput.value || '').trim().toLowerCase();
            var opts = dropdown.querySelectorAll('.custom-select-option');
            var realVisible = 0;
            for (var i = 0; i < opts.length; i++) {
              var opt = opts[i];
              // Match against label AND description — the option's full text.
              var match = !q || (opt.textContent || '').toLowerCase().indexOf(q) !== -1;
              // SIMPLE RULE (PR-F1 spec §2, the "acceptable simpler rule"): the
              // __create__ affordance is ALWAYS visible while filtering — it is
              // the "nothing matched, make one" escape hatch — and (None) filters
              // like any other option.
              var show = isCreateOption(opt) ? true : match;
              opt.style.display = show ? '' : 'none';
              if (show && isRealOption(opt)) realVisible++;
            }
            if (noMatches) {
              // Only meaningful when there is no create affordance to fall back
              // on; when a create option is present it stays visible and speaks
              // for the empty result itself.
              noMatches.style.display = (realVisible === 0 && !hasCreateOption) ? '' : 'none';
            }
            var h = highlighted();
            if (h && h.style.display === 'none') clearHighlight();
          }

          resetFilter = function() {
            filterInput.value = '';
            applyFilter();
            clearHighlight();
          };

          filterInput.addEventListener('input', function() { applyFilter(); });
          filterInput.addEventListener('keydown', function(e) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              var vis = visibleOptions();
              if (vis.length === 0) return;
              var cur = highlighted();
              var idx = -1;
              for (var ki = 0; ki < vis.length; ki++) { if (vis[ki] === cur) { idx = ki; break; } }
              if (e.key === 'ArrowDown') { idx = idx < 0 ? 0 : Math.min(idx + 1, vis.length - 1); }
              else { idx = idx < 0 ? vis.length - 1 : Math.max(idx - 1, 0); }
              setHighlight(vis[idx]);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              var target = highlighted();
              if (!target) {
                var only = visibleOptions();
                if (only.length === 1) target = only[0];
              }
              if (target) chooseOption(target);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setCustomSelectOpen(wrapper, false);
              if (trigger) trigger.focus();
            }
          });
        })(customSelects[cs]);
      }
    }

    function initCustomComboboxes() {
      var combos = document.querySelectorAll('.custom-combobox');
      for (var ci = 0; ci < combos.length; ci++) {
        (function(combo) {
          var input = combo.querySelector('input[type="text"]');
          var dropdown = combo.querySelector('.custom-select-dropdown');
          var allOptions = dropdown.querySelectorAll('.custom-select-option');

          function showFiltered(filter) {
            var count = 0;
            for (var i = 0; i < allOptions.length; i++) {
              var match = !filter || allOptions[i].textContent.toLowerCase().indexOf(filter.toLowerCase()) !== -1;
              allOptions[i].style.display = match ? '' : 'none';
              if (match) count++;
            }
            if (count > 0) { combo.classList.add('open'); } else { combo.classList.remove('open'); }
          }

          input.addEventListener('focus', function() { showFiltered(input.value); });
          input.addEventListener('input', function() { showFiltered(input.value); });
          input.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') combo.classList.remove('open');
          });

          for (var oi = 0; oi < allOptions.length; oi++) {
            (function(opt) {
              opt.addEventListener('mousedown', function(e) {
                e.preventDefault();
                input.value = opt.dataset.value;
                combo.classList.remove('open');
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              });
            })(allOptions[oi]);
          }
        })(combos[ci]);
      }
    }`;
}
