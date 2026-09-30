# The extension itself, built from this repo (same file set `make pack` ships
# to EGO: no scripts/, polkit/, systemd/, nix/).
{
  lib,
  stdenvNoCC,
  glib,
  gettext,
}:
let
  metadata = lib.importJSON ../metadata.json;
in
stdenvNoCC.mkDerivation {
  pname = "gnome-shell-extension-tor-ext";
  version = metadata."version-name";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../metadata.json
      ../extension.js
      ../prefs.js
      ../stylesheet.css
      ../lib
      ../ui
      ../icons
      ../po
      ../schemas/org.gnome.shell.extensions.tor-ext.gschema.xml
    ];
  };

  nativeBuildInputs = [
    glib
    gettext
  ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    glib-compile-schemas --strict schemas
    for po in po/*.po; do
      lang=$(basename "$po" .po)
      mkdir -p "locale/$lang/LC_MESSAGES"
      msgfmt -o "locale/$lang/LC_MESSAGES/tor-ext.mo" "$po"
    done
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    dest=$out/share/gnome-shell/extensions/${metadata.uuid}
    mkdir -p "$dest"
    cp -r metadata.json extension.js prefs.js stylesheet.css lib ui icons locale schemas "$dest"/
    runHook postInstall
  '';

  passthru.extensionUuid = metadata.uuid;

  meta = {
    description = metadata.description;
    homepage = metadata.url;
    license = lib.licenses.mit; # per README
    platforms = lib.platforms.linux;
  };
}
