# nixos-guard.sh — sourced by the host-setup scripts. On NixOS they cannot
# work (/etc is generated from the system configuration, /usr/local is not on
# PATH, there is no apt/dnf/pacman/zypper), so point at the NixOS module
# instead and stop before touching anything.
#
# Usage (after `set -euo pipefail`):
#   . "$(dirname "${BASH_SOURCE[0]}")/nixos-guard.sh"
#   nixos_guard install|uninstall|torrc

nixos_guard() {
    [[ -e /etc/NIXOS ]] || return 0

    local what=${1:-install}
    {
        echo "!! NixOS detected — this script edits /etc and /usr/local, which NixOS generates"
        echo "   from your configuration, so it would not stick (or would fail outright)."
        echo
        case $what in
            uninstall)
                echo "   To remove tor-ext's system backend, delete the services.tor-ext block"
                echo "   from your configuration and rebuild (nixos-rebuild switch)."
                ;;
            *)
                cat <<'EOM'
   Use the NixOS module shipped in this repo instead. With flakes:

     # flake.nix
     inputs.tor-ext.url = "github:vipinus/gnome-shell-extension-tor";
     # nixosConfigurations.<host>.modules:
     tor-ext.nixosModules.default

     # configuration.nix
     services.tor-ext = {
       enable = true;
       users = [ "<you>" ];               # may read tor's control cookie
       transparentProxy.enable = true;    # optional: whole-machine Tor via tun2socks
     };

   Without flakes: imports = [ "${fetchTarball "https://github.com/vipinus/gnome-shell-extension-tor/archive/main.tar.gz"}/nix/module.nix" ];
   (that variant installs the extension from nixpkgs' gnomeExtensions.tor).

   Then nixos-rebuild switch, log out and back in. Details: README.md, "NixOS".
EOM
                ;;
        esac
    } >&2
    exit 1
}
