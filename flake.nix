{
  description = "Minimalist unofficial FUSE mount of Proton Drive";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems =
        f: nixpkgs.lib.genAttrs systems (system: f system (import nixpkgs { inherit system; }));
    in
    {
      packages = forAllSystems (
        _system: pkgs: rec {
          proton-drive = pkgs.callPackage ./nix/package.nix { };
          default = proton-drive;
        }
      );

      apps = forAllSystems (
        system: _pkgs: {
          default = {
            type = "app";
            program = "${self.packages.${system}.default}/bin/proton-drive";
          };
        }
      );

      devShells = forAllSystems (
        _system: pkgs: {
          default = pkgs.callPackage ./nix/devshell.nix { };
        }
      );

      # Import into home-manager, then set:
      #   programs.proton-drive.enable = true;
      homeManagerModules.default = import ./nix/module.nix;

      formatter = forAllSystems (_system: pkgs: pkgs.nixfmt-tree);
    };
}
