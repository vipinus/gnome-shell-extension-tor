# NixOS VM test for nix/module.nix:  nix build .#checks.x86_64-linux.vm
#
# The VM has no internet, so tor never bootstraps; what is checked is the
# plumbing the extension depends on: ports, cookie permissions, the polkit
# rule (from a real local session, i.e. no password prompt), the obfs4
# plugin being exec'able from tor's chroot, and transparent-proxy up/down.
{ module }:
{
  name = "tor-ext";

  nodes.machine =
    { pkgs, ... }:
    {
      imports = [ module ];

      services.tor-ext = {
        enable = true;
        users = [ "alice" ];
        transparentProxy.enable = true;
      };

      # A GNOME desktop runs avahi on UDP 5353 too; make sure tor's DNSPort
      # (127.0.0.1:5353) still binds next to it.
      services.avahi.enable = true;

      users.users.alice.isNormalUser = true;
      users.users.bob.isNormalUser = true; # not in services.tor-ext.users
      # tty1 autologin gives alice an active local logind session, which is
      # what the polkit rule requires.
      services.getty.autologinUser = "alice";

      environment.systemPackages = [
        pkgs.netcat-openbsd
        pkgs.xxd
        pkgs.nftables # only for the assertions; tor-ext-routing brings its own
      ];
    };

  testScript =
    { nodes, ... }:
    let
      cfg = nodes.machine.services.tor-ext;
      lyrebird = "${cfg.obfs4Package}/bin/lyrebird";
      uuid = cfg.package.extensionUuid;
    in
    ''
      def ctl(cmds, user="root"):
          script = (
              'c=$(xxd -p -c 64 /run/tor/control.authcookie); '
              f'printf "AUTHENTICATE %s\\r\\n{cmds}QUIT\\r\\n" "$c" | nc -q 2 127.0.0.1 9051'
          )
          if user == "root":
              return machine.succeed(script)
          return machine.succeed(f"su {user} -c '{script}'")

      step = 0

      def as_alice_session(cmd):
          # Type into alice's autologin shell on tty1 (her active local session)
          # and wait for its exit status, so a polkit denial shows up here
          # instead of as a unit that silently never started.
          global step
          step += 1
          out = f"/tmp/alice-{step}"
          machine.send_chars(f"{cmd} --no-ask-password > {out}.log 2>&1; echo $? > {out}.rc\n")
          machine.wait_for_file(f"{out}.rc")
          rc = machine.succeed(f"cat {out}.rc").strip()
          log = machine.succeed(f"cat {out}.log")
          if rc != "0":
              print(machine.execute(
                  "systemctl status --no-pager -l tor-ext-tun2socks.service; "
                  "journalctl -b --no-pager -o cat -u tor-ext-tun2socks.service | tail -30"
              )[1])
          assert rc == "0", f"alice: {cmd} -> rc={rc}: {log}"

      machine.wait_for_unit("multi-user.target")
      machine.wait_until_succeeds("loginctl show-user alice -p State | grep -q active")
      machine.wait_until_tty_matches("1", "alice@machine")

      with subtest("extension is installed with compiled schemas"):
          machine.succeed("test -f /run/current-system/sw/share/gnome-shell/extensions/${uuid}/metadata.json")
          machine.succeed("test -f /run/current-system/sw/share/gnome-shell/extensions/${uuid}/schemas/gschemas.compiled")
          # NixOS compiles the dconf defaults into a store db referenced by the profile.
          machine.succeed("grep -q '${lyrebird}' $(sed -n 's/^file-db://p' /etc/dconf/profile/user)")

      with subtest("tor is not started at boot"):
          machine.fail("systemctl is-active tor.service")
          machine.fail("systemctl is-active tor-ext-tun2socks.service")

      with subtest("polkit rule loaded without errors"):
          # polkit is D-Bus activated; start it so the rules get parsed now.
          machine.succeed("systemctl start polkit.service")
          machine.wait_for_unit("polkit.service")
          machine.fail("journalctl -u polkit.service | grep -iE 'error|exception'")

      with subtest("alice starts tor from her session without a password"):
          as_alice_session("systemctl start tor.service")
          machine.wait_for_unit("tor.service")
          try:
              machine.wait_until_succeeds("ss -ltn | grep -q '127.0.0.1:9050'", timeout=120)
          except Exception:
              print(machine.execute("journalctl -u tor.service --no-pager | tail -40; ss -lunp; ss -ltnp")[1])
              raise
          machine.wait_until_succeeds("ss -ltn | grep -q '127.0.0.1:9051'", timeout=60)
          machine.wait_until_succeeds("ss -lun | grep -q '127.0.0.1:5353'", timeout=60)

      with subtest("control cookie: tor group can read it, others cannot"):
          machine.succeed("su alice -c 'test -r /run/tor/control.authcookie'")
          machine.fail("su bob -c 'test -r /run/tor/control.authcookie'")
          out = ctl("GETINFO version\\r\\n", user="alice")
          assert "250-version=" in out, out

      with subtest("obfs4 plugin (store path) is exec'd from tor's chroot"):
          bridge = "obfs4 37.218.245.14:38224 D9A82D2F9C2F65A18407B1D2B764F130847F8B5D cert=bjRaMrr1BRiAW8IE9U5z27fQaYgOhX1UCmOpg2pFpoMvo6ZgQMzLsaTzzQNTlm7hNcb+Sg iat-mode=0"
          out = ctl(
              f'SETCONF UseBridges=1 Bridge=\\"{bridge}\\" '
              'ClientTransportPlugin=\\"obfs4 exec ${lyrebird}\\"\\r\\n'
          )
          assert "250 OK" in out, out
          machine.wait_until_succeeds("pgrep -u tor -f lyrebird")
          ctl("SETCONF UseBridges=0\\r\\n")

      with subtest("transparent proxy comes up from alice's session"):
          machine.succeed("sysctl -n net.ipv6.conf.all.disable_ipv6 | grep -qx 0")
          as_alice_session("systemctl start tor-ext-tun2socks.service")
          machine.wait_for_unit("tor-ext-tun2socks.service")
          machine.wait_until_succeeds("ip link show ${cfg.transparentProxy.tunDevice}")
          tor_uid = machine.succeed("id -u tor").strip()
          machine.wait_until_succeeds("ip rule show | grep -q 'lookup 100'")
          machine.succeed(f"ip rule show | grep -q 'uidrange {tor_uid}-{tor_uid} lookup main'")
          machine.succeed("ip route show table 100 | grep -q 'default dev ${cfg.transparentProxy.tunDevice}'")
          machine.succeed("nft list table inet tor-ext | grep -q 'dnat ip to 127.0.0.1:5353'")
          machine.succeed("sysctl -n net.ipv6.conf.all.disable_ipv6 | grep -qx 1")

      with subtest("stopping tor takes the transparent proxy down and restores routing"):
          as_alice_session("systemctl stop tor.service")
          machine.wait_until_fails("systemctl is-active tor.service")
          machine.wait_until_fails("systemctl is-active tor-ext-tun2socks.service")
          machine.wait_until_fails("ip link show ${cfg.transparentProxy.tunDevice}")
          machine.fail("ip rule show | grep -q 'lookup 100'")
          machine.fail("nft list table inet tor-ext")
          machine.succeed("sysctl -n net.ipv6.conf.all.disable_ipv6 | grep -qx 0")

      with subtest("bob (no active session) still needs authorization"):
          machine.fail("su bob -c 'systemctl --no-ask-password start tor.service'")
    '';
}
