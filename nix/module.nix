# NixOS module for tor-ext's system backend — the declarative counterpart of
# scripts/install-tor-tun2socks.sh (which cannot work on NixOS: /etc is
# generated, /usr/local is not on PATH, there is no apt/dnf/pacman).
#
#   services.tor-ext = {
#     enable = true;
#     users = [ "alice" ];                  # may read tor's control cookie
#     transparentProxy.enable = true;       # optional: whole-machine Tor via tun2socks
#   };
#
# What each piece maps to in the installer:
#   tor package + torrc patching      → services.tor.{enable,settings}
#   usermod -aG <tor group>           → users.users.<name>.extraGroups
#   51-tor-ext-tun2socks.rules        → security.polkit.extraConfig
#   tun2socks download                → pkgs.tun2socks
#   /usr/local/libexec/tor-ext/…      → tor-ext-routing wrapped with its runtime deps
#   tor-ext-tun2socks.service         → systemd.services.tor-ext-tun2socks
#   /usr/lib/systemd/system-sleep/…   → powerManagement.resumeCommands
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.tor-ext;
  tp = cfg.transparentProxy;

  # NixOS runs tor chrooted under /run/tor/root with /nix/store bind-mounted,
  # so pluggable-transport binaries must be given as store paths — a
  # /run/current-system/sw/bin symlink does not resolve inside the chroot.
  obfs4Binary = lib.getExe' cfg.obfs4Package "lyrebird";

  routing = pkgs.runCommand "tor-ext-routing" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
    install -Dm755 ${../scripts/tor-ext-routing} $out/bin/tor-ext-routing
    patchShebangs $out/bin
    wrapProgram $out/bin/tor-ext-routing --prefix PATH : ${
      lib.makeBinPath (
        with pkgs;
        [
          iproute2
          nftables
          iptables
          procps
          gnugrep
          coreutils
          util-linux
        ]
      )
    }
  '';

  ip = lib.getExe' pkgs.iproute2 "ip";

  units = [ "tor.service" ] ++ lib.optional tp.enable "tor-ext-tun2socks.service";
in
{
  options.services.tor-ext = {
    enable = lib.mkEnableOption "the system backend for the tor-ext GNOME Shell extension (system tor.service driven from Quick Settings via polkit)";

    package = lib.mkPackageOption pkgs [ "gnomeExtensions" "tor" ] {
      extraDescription = "The flake in the tor-ext repository sets this to the extension built from the same checkout.";
    };

    users = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "alice" ];
      description = "Users added to the `tor` group so the extension can read tor's control cookie. They must log out and back in once.";
    };

    autostart = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Start tor at boot. Off by default: the Quick Settings tile owns tor's lifecycle.";
    };

    socksPort = lib.mkOption {
      type = lib.types.port;
      default = 9050;
      description = "tor SOCKS5 port (extension setting `socks-port`).";
    };

    controlPort = lib.mkOption {
      type = lib.types.port;
      default = 9051;
      description = "tor ControlPort (extension setting `control-port`).";
    };

    obfs4Package = lib.mkPackageOption pkgs "lyrebird" {
      extraDescription = "Pluggable transport for obfs4 / meek_lite / scramblesuit bridges (lyrebird is the maintained successor of obfs4proxy).";
    };

    transparentProxy = {
      enable = lib.mkEnableOption "transparent-proxy mode: route all IPv4 TCP through tor via tun2socks (IPv6 is disabled while it is up)";

      package = lib.mkPackageOption pkgs "tun2socks" { };

      tunDevice = lib.mkOption {
        type = lib.types.str;
        default = "tun-tor";
        description = "TUN device created while transparent-proxy mode is up.";
      };

      tunAddress = lib.mkOption {
        type = lib.types.str;
        default = "10.66.66.1/24";
        description = "Address assigned to the TUN device.";
      };

      dnsPort = lib.mkOption {
        type = lib.types.port;
        default = 5353;
        description = "tor DNSPort; DNS arriving on the TUN is redirected here.";
      };
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        environment.systemPackages = [
          cfg.package
          cfg.obfs4Package
        ];
        # GNOME's module links this too; declare it so the extension is found
        # even when the desktop is configured some other way.
        environment.pathsToLink = [ "/share/gnome-shell/extensions" ];
        programs.dconf.enable = true; # for the defaults below

        services.tor = {
          enable = true;
          # The SOCKS port has to come from the client module: with
          # client.enable off, NixOS forces `SOCKSPort 0` (mkForce), which
          # silently disables SOCKS no matter what settings.SOCKSPort says.
          client.enable = true;
          client.socksListenAddress = lib.mkIf (cfg.socksPort != 9050) {
            addr = "127.0.0.1";
            port = cfg.socksPort;
          };
          settings = {
            ControlPort = [ cfg.controlPort ];
            CookieAuthentication = true;
            # The extension's default `cookie-path`; readable by the tor group.
            CookieAuthFile = "/run/tor/control.authcookie";
            CookieAuthFileGroupReadable = true;
          };
        };

        systemd.services.tor.wantedBy = lib.mkIf (!cfg.autostart) (lib.mkForce [ ]);

        users.users = lib.genAttrs cfg.users (_: {
          extraGroups = [ "tor" ];
        });

        # Same rule as polkit/51-tor-ext-tun2socks.rules, limited to the units
        # this host actually has. polkit cannot see which program asks, so this
        # lets any process of an active local user start/stop these units.
        security.polkit.enable = true;
        security.polkit.extraConfig = ''
          // tor-ext: active local users start/stop tor (and tun2socks) without a password.
          polkit.addRule(function (action, subject) {
            if (action.id !== "org.freedesktop.systemd1.manage-units") return;
            if (!subject.active || !subject.local) return;
            var units = ${builtins.toJSON units};
            if (units.indexOf(action.lookup("unit") || "") < 0) return;
            var verbs = ["start", "stop", "restart", "reload", "try-restart", "reload-or-restart"];
            if (verbs.indexOf(action.lookup("verb") || "") >= 0) return polkit.Result.YES;
          });
        '';

        # Defaults for the extension's settings (users can still override them).
        programs.dconf.profiles.user.databases = [
          {
            settings."org/gnome/shell/extensions/tor-ext" = {
              obfs4-binary = obfs4Binary;
              socks-port = lib.gvariant.mkInt32 cfg.socksPort;
              control-port = lib.gvariant.mkInt32 cfg.controlPort;
              tor-dns-port = lib.gvariant.mkInt32 tp.dnsPort;
              tun-device = tp.tunDevice;
              tun-address = tp.tunAddress;
            };
          }
        ];
      }

      (lib.mkIf tp.enable {
        boot.kernelModules = [ "tun" ];

        services.tor.settings = {
          DNSPort = [ tp.dnsPort ];
          AutomapHostsOnResolve = true;
          VirtualAddrNetworkIPv4 = "10.192.0.0/10";
        };

        # Not wanted by anything: the tile starts it (BindsTo tor, so stopping
        # tor stops it too).
        systemd.services.tor-ext-tun2socks = {
          description = "tor-ext transparent proxy (tun2socks -> tor SOCKS5)";
          documentation = [ "https://github.com/vipinus/gnome-shell-extension-tor" ];
          bindsTo = [ "tor.service" ];
          after = [
            "tor.service"
            "network-online.target"
          ];
          wants = [ "network-online.target" ];
          environment = {
            TUN_DEV = tp.tunDevice;
            TUN_ADDR = tp.tunAddress;
            SOCKS_PORT = toString cfg.socksPort;
            DNS_PORT = toString tp.dnsPort;
          };
          serviceConfig = {
            Type = "simple";
            ExecStartPre = [
              "${ip} tuntap add dev ${tp.tunDevice} mode tun"
              "${ip} addr add ${tp.tunAddress} dev ${tp.tunDevice}"
              "${ip} link set dev ${tp.tunDevice} up mtu 1500"
            ];
            # tun2socks 2.6 switched to zap levels and exits with
            # `unrecognized level: "warning"`; 2.5.x (what the installer
            # downloads) still wants "warning".
            ExecStart = "${lib.getExe' tp.package "tun2socks"} -device ${tp.tunDevice} -proxy socks5://127.0.0.1:${toString cfg.socksPort} -loglevel ${
              if lib.versionAtLeast tp.package.version "2.6" then "warn" else "warning"
            }";
            ExecStartPost = "${routing}/bin/tor-ext-routing up";
            ExecStopPost = [
              "${routing}/bin/tor-ext-routing down"
              "-${ip} tuntap del dev ${tp.tunDevice} mode tun"
            ];
            RuntimeDirectory = "tor-ext";
            RuntimeDirectoryMode = "0755";
            Restart = "on-failure";
            RestartSec = "3s";
          };
        };

        # NetworkManager resets per-interface IPv6 sysctls on resume; re-assert.
        powerManagement.resumeCommands = ''
          if ${config.systemd.package}/bin/systemctl is-active --quiet tor-ext-tun2socks.service; then
            ${routing}/bin/tor-ext-routing up || true
          fi
        '';
      })
    ]
  );
}
