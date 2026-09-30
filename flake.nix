{
  description = "tor-ext: GNOME Shell extension to control Tor from Quick Settings, plus a NixOS module for its system backend";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        tor-ext = pkgs.callPackage ./nix/package.nix { };
        default = tor-ext;
      });

      # Imports nix/module.nix and makes it install the extension built from
      # this checkout instead of the EGO snapshot in nixpkgs (gnomeExtensions.tor).
      nixosModules.default =
        { lib, pkgs, ... }:
        {
          imports = [ ./nix/module.nix ];
          services.tor-ext.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.tor-ext;
        };

      checks = forAllSystems (pkgs: {
        vm = pkgs.testers.runNixOSTest (import ./nix/test.nix { module = self.nixosModules.default; });
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
