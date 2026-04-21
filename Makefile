UUID        = tor-ext@fabric.soul7.gmail.com
EXT_DIR     = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
POLKIT_RULES_DIR = /etc/polkit-1/rules.d
SCHEMA_ID   = org.gnome.shell.extensions.tor-ext

SRC_FILES = metadata.json extension.js stylesheet.css \
            $(wildcard lib/*.js) $(wildcard ui/*.js) \
            schemas/$(SCHEMA_ID).gschema.xml \
            $(wildcard icons/*.svg)

.PHONY: all install uninstall enable disable reload schemas pack clean polkit-install polkit-uninstall tun2socks-install tun2socks-uninstall check

all: schemas

schemas: schemas/gschemas.compiled

schemas/gschemas.compiled: schemas/$(SCHEMA_ID).gschema.xml
	glib-compile-schemas schemas/

install: schemas
	@mkdir -p $(EXT_DIR)
	@cp -r metadata.json extension.js stylesheet.css $(EXT_DIR)/
	@[ -f prefs.js ] && cp prefs.js $(EXT_DIR)/ || true
	@mkdir -p $(EXT_DIR)/lib $(EXT_DIR)/ui $(EXT_DIR)/schemas $(EXT_DIR)/icons $(EXT_DIR)/scripts
	@cp -r lib/*.js $(EXT_DIR)/lib/ 2>/dev/null || true
	@cp -r ui/*.js $(EXT_DIR)/ui/ 2>/dev/null || true
	@cp -r icons/*.svg $(EXT_DIR)/icons/ 2>/dev/null || true
	@cp -r scripts/* $(EXT_DIR)/scripts/ 2>/dev/null || true
	@cp schemas/$(SCHEMA_ID).gschema.xml schemas/gschemas.compiled $(EXT_DIR)/schemas/
	@echo "installed -> $(EXT_DIR)"

uninstall:
	@rm -rf $(EXT_DIR)
	@echo "removed $(EXT_DIR)"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

reload: install
	@echo "Wayland: logout/login to reload; X11: Alt+F2 -> r"

polkit-install:
	sudo install -m 0644 polkit/50-tor-ext.rules $(POLKIT_RULES_DIR)/50-tor-ext.rules
	sudo systemctl reload polkit 2>/dev/null || sudo systemctl restart polkit || true
	@echo "polkit rule installed; active local users can now manage tor@default.service with a one-time password prompt"

polkit-uninstall:
	sudo rm -f $(POLKIT_RULES_DIR)/50-tor-ext.rules
	sudo systemctl reload polkit 2>/dev/null || true

tun2socks-install:
	bash scripts/install-tor-tun2socks.sh

tun2socks-uninstall:
	@echo "stopping + disabling system units…"
	-sudo systemctl stop tor-ext-tun2socks.service tor-ext.service 2>/dev/null || true
	-sudo systemctl disable tor-ext-tun2socks.service tor-ext.service 2>/dev/null || true
	sudo rm -f /etc/systemd/system/tor-ext.service \
	           /etc/systemd/system/tor-ext-tun2socks.service \
	           /etc/polkit-1/rules.d/51-tor-ext-tun2socks.rules \
	           /usr/local/libexec/tor-ext/tor-ext-routing \
	           /usr/lib/systemd/system-sleep/tor-ext
	sudo rmdir /usr/local/libexec/tor-ext 2>/dev/null || true
	sudo systemctl daemon-reload
	sudo systemctl reload polkit 2>/dev/null || true
	@echo "(tun2socks binary, _tor-ext user, /etc/tor-ext and /var/lib/tor-ext left in place — remove manually if desired)"

pack: schemas
	@# EGO submission: scripts/, polkit/, systemd/ MUST NOT be in the zip —
	@# they are part of one-time host setup, not the extension runtime.
	gnome-extensions pack \
	    --force \
	    --extra-source=lib \
	    --extra-source=ui \
	    --extra-source=icons \
	    --schema=schemas/$(SCHEMA_ID).gschema.xml \
	    .
	@echo "-- inspecting zip contents (should NOT contain scripts/, polkit/, systemd/) --"
	@if unzip -l $(UUID).shell-extension.zip | awk '{print $$NF}' | grep -E "^(scripts|polkit|systemd)/" >/dev/null; then \
	    echo "!! FAIL: host-only files leaked into pack"; exit 1; \
	else \
	    echo "ok, zip is clean ($$(stat -c %s $(UUID).shell-extension.zip) bytes)"; \
	fi

check:
	@echo "-- metadata --" && cat metadata.json
	@echo "-- schema compile --" && glib-compile-schemas --strict --dry-run schemas/
	@echo "-- shell version --" && gnome-shell --version
	@echo "-- extension state --" && gnome-extensions info $(UUID) 2>/dev/null || echo "(not installed yet)"

clean:
	rm -f schemas/gschemas.compiled
	rm -f *.zip
