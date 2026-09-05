//! Flashlight state types: the point-in-time snapshot of the illumination torch.

/// Point-in-time state of the illumination flashlight (torch).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FlashlightState {
    /// Whether the torch is currently **lit** (illuminating).
    pub on: bool,
    /// Whether this device actually has a usable torch: a rear camera with a
    /// flash unit whose LED can be driven as a steady light (`torch_present`).
    /// This is a hardware fact reported by the provider, not a permission.
    pub torch_present: bool,
}

impl FlashlightState {
    /// A device that has torch hardware and is currently dark (off).
    pub const fn off_with_torch() -> Self {
        Self {
            on: false,
            torch_present: true,
        }
    }

    /// A device that has torch hardware and is currently lit.
    pub const fn on_with_torch() -> Self {
        Self {
            on: true,
            torch_present: true,
        }
    }

    /// A device with no usable torch hardware at all (nothing to illuminate).
    pub const fn no_torch() -> Self {
        Self {
            on: false,
            torch_present: false,
        }
    }

    /// True when the torch is lit.
    pub fn lit(self) -> bool {
        self.on
    }

    /// True when a usable torch exists on this device (regardless of on/off).
    pub fn available(self) -> bool {
        self.torch_present
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_dark_and_conservative() {
        // A conservative default: no torch, not lit. Real callers seed the mock /
        // provider with the true hardware picture (see provider.rs).
        let s = FlashlightState::default();
        assert!(!s.lit());
        assert!(!s.available());
    }

    #[test]
    fn constructors_describe_meaningful_worlds() {
        assert_eq!(
            FlashlightState::off_with_torch(),
            FlashlightState {
                on: false,
                torch_present: true,
            }
        );
        assert!(FlashlightState::on_with_torch().lit());
        assert!(FlashlightState::on_with_torch().available());
        assert!(!FlashlightState::no_torch().available());
        assert!(!FlashlightState::no_torch().lit());
    }
}
