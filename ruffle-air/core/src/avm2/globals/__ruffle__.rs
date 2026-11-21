use crate::avm2::activation::Activation;
use crate::avm2::bytearray::ByteArrayStorage;
use crate::avm2::error::Error;
use crate::avm2::function::FunctionArgs;
use crate::avm2::object::ByteArrayObject;
use crate::avm2::parameters::ParametersExt;
use crate::avm2::value::Value;
use crate::string::AvmString;
use crate::string::WStr;
use crate::stub::Stub;
use std::borrow::Cow;

pub fn stub_method<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Value<'gc>,
    args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    let class = args.get_string(activation, 0);
    let method = args.get_string(activation, 1);
    let specifics = args.try_get_string(2);

    let class = Cow::Owned(class.to_utf8_lossy().to_string());
    let method = Cow::Owned(method.to_utf8_lossy().to_string());
    let specifics = specifics.map(|s| Cow::Owned(s.to_utf8_lossy().to_string()));

    activation
        .context
        .stub_tracker
        .encounter(&Stub::Avm2Method {
            class,
            method,
            specifics,
        });

    Ok(Value::Undefined)
}

pub fn stub_getter<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Value<'gc>,
    args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    let class = args.get_string(activation, 0);
    let property = args.get_string(activation, 1);

    let class = Cow::Owned(class.to_utf8_lossy().to_string());
    let property = Cow::Owned(property.to_utf8_lossy().to_string());

    activation
        .context
        .stub_tracker
        .encounter(&Stub::Avm2Getter { class, property });

    Ok(Value::Undefined)
}

pub fn stub_setter<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Value<'gc>,
    args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    let class = args.get_string(activation, 0);
    let property = args.get_string(activation, 1);

    let class = Cow::Owned(class.to_utf8_lossy().to_string());
    let property = Cow::Owned(property.to_utf8_lossy().to_string());

    activation
        .context
        .stub_tracker
        .encounter(&Stub::Avm2Setter { class, property });

    Ok(Value::Undefined)
}

pub fn stub_constructor<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Value<'gc>,
    args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    let class = args.get_string(activation, 0);
    let specifics = args.try_get_string(1);

    let class = Cow::Owned(class.to_utf8_lossy().to_string());
    let specifics = specifics.map(|s| Cow::Owned(s.to_utf8_lossy().to_string()));

    activation
        .context
        .stub_tracker
        .encounter(&Stub::Avm2Constructor { class, specifics });

    Ok(Value::Undefined)
}

pub fn log_warn<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Value<'gc>,
    args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    let strings = args
        .iter()
        .map(|a| a.coerce_to_string(activation))
        .collect::<Result<Vec<_>, _>>()?;
    let msg = crate::string::join(&strings, &WStr::from_units(b" "));
    let msg = msg.to_utf8_lossy();
    tracing::warn!("{}", &msg);

    Ok(Value::Undefined)
}

pub fn is_dependent<'gc>(
    _activation: &mut Activation<'_, 'gc>,
    _this: Value<'gc>,
    args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(s) = args.try_get_string(0) {
        return Ok(s.is_dependent().into());
    }

    panic!();
}

/// The virtual filesystem used for `File.desktopDirectory`.
///
/// Files are stored in Ruffle's persistent storage backend, which is backed by
/// `localStorage` on the web. This keeps AIR applications from touching the
/// real filesystem and gives them a writable directory in the browser.
const DESKTOP_VFS_ROOT: &str = "vfs://desktop/";

fn is_vfs_url(url: &str) -> bool {
    url.starts_with("vfs://")
}

fn read_vfs_file<'gc>(
    activation: &mut Activation<'_, 'gc>,
    url: &str,
) -> Option<Vec<u8>> {
    if is_vfs_url(url) {
        activation.context.storage.get(url)
    } else {
        activation.context.navigator.read_file_sync(url)
    }
}

/// Implements `__ruffle__.airApplicationDirectoryUrl`
pub fn air_application_directory_url<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Value<'gc>,
    _args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    // The navigator's base URL is the directory containing the root SWF. For
    // AIR applications it is set from the application descriptor.
    let url = activation
        .context
        .navigator
        .resolve_url("")
        .map(|url| url.to_string())
        .unwrap_or_default();

    Ok(AvmString::new_utf8(activation.gc(), url).into())
}

/// Implements `__ruffle__.airDesktopDirectoryUrl`
pub fn air_desktop_directory_url<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Value<'gc>,
    _args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    Ok(AvmString::new_utf8(activation.gc(), DESKTOP_VFS_ROOT).into())
}

/// Implements `__ruffle__.airFileExists`
pub fn air_file_exists<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Value<'gc>,
    args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    let url = args.get_string(activation, 0).to_utf8_lossy().to_string();

    let exists = if is_vfs_url(&url) {
        activation.context.storage.get(&url).is_some()
    } else {
        activation.context.navigator.read_file_sync(&url).is_some()
    };

    Ok(exists.into())
}

/// Implements `__ruffle__.airFileSize`
pub fn air_file_size<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Value<'gc>,
    args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    let url = args.get_string(activation, 0).to_utf8_lossy().to_string();

    let size = read_vfs_file(activation, &url)
        .map(|data| data.len())
        .unwrap_or(0);

    Ok(Value::Number(size as f64))
}

/// Implements `__ruffle__.airReadFile`
pub fn air_read_file<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Value<'gc>,
    args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    let url = args.get_string(activation, 0).to_utf8_lossy().to_string();

    let Some(data) = read_vfs_file(activation, &url) else {
        return Ok(Value::Null);
    };

    let storage = ByteArrayStorage::from_vec(activation.context, data);
    let byte_array = ByteArrayObject::from_storage(activation.context, storage);
    Ok(byte_array.into())
}

/// Implements `__ruffle__.airWriteFile`
pub fn air_write_file<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Value<'gc>,
    args: FunctionArgs<'_, 'gc>,
) -> Result<Value<'gc>, Error<'gc>> {
    let url = args.get_string(activation, 0).to_utf8_lossy().to_string();

    if !is_vfs_url(&url) {
        // Only the virtual desktop is writable.
        return Ok(false.into());
    }

    let Some(data) = args.try_get_object(1) else {
        return Ok(false.into());
    };
    let data = data
        .as_bytearray()
        .expect("FileStream passes a ByteArray");
    let data = data.bytes().to_vec();

    Ok(activation.context.storage.put(&url, &data).into())
}
