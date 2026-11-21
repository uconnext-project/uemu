//! Runtime patches for AIR content.
//!
//! Some applications contain trace helpers that are compiled with a static
//! "enable traces" flag which is never turned on in the shipped binaries. The
//! HMI's `com.nfuzion.framework.global.Framework.Trace()` is one of those:
//!
//! ```actionscript
//! public static var enableTrace:Boolean = false;
//!
//! public static function Trace(param1:String) : void {
//!     if (enableTrace) {
//!         trace(param1);
//!     }
//! }
//! ```
//!
//! Rather than patching the SWF, this hook runs after a class initializer and
//! flips the flag on in AIR mode. `Framework.Trace()` then forwards every call
//! to the regular `trace()` implementation (and thus to the HUD log).

use crate::avm2::Multiname;
use crate::avm2::activation::Activation;
use crate::avm2::error::Error;
use crate::avm2::object::ClassObject;
use crate::avm2::value::Value;
use crate::player::PlayerRuntime;
use crate::string::AvmString;

/// Local name of the class that owns the HMI trace gate.
const HMI_FRAMEWORK_NAME: &[u8] = b"Framework";

/// Package of that class.
const HMI_FRAMEWORK_PACKAGE: &[u8] = b"com.nfuzion.framework.global";

/// Applies per-class runtime patches after the class initializer has run.
///
/// Called for every initialized class, so keep the checks cheap and return
/// early for non-AIR runtimes.
pub fn post_class_initializer<'gc>(
    class_object: ClassObject<'gc>,
    activation: &mut Activation<'_, 'gc>,
) -> Result<(), Error<'gc>> {
    if activation.avm2().player_runtime != PlayerRuntime::AIR {
        return Ok(());
    }

    let name = class_object.name();
    if name.local_name().as_wstr() != HMI_FRAMEWORK_NAME {
        return Ok(());
    }
    let Some(package) = name.namespace().as_uri_opt() else {
        return Ok(());
    };
    if package.as_wstr() != HMI_FRAMEWORK_PACKAGE {
        return Ok(());
    }

    // `Framework.Trace()` reads this flag on every call; setting it once after
    // the class initializer is enough. The static initializer assigns `false`,
    // so the write has to happen after the initializer has finished.
    let multiname = Multiname::new(
        activation.avm2().find_public_namespace(),
        AvmString::new_utf8(activation.gc(), "enableTrace"),
    );
    let class_value: Value<'gc> = Value::Object(class_object.into());
    class_value.set_property(&multiname, Value::Bool(true), activation)?;

    Ok(())
}
