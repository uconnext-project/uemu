package __ruffle__ {
    import flash.utils.ByteArray;

    // Mark the method where this function is invoked as stubbed.
    public native function stub_method(className:String, methodName:String, specifics:String = null):void;

    // Mark the getter where this function is invoked as stubbed.
    public native function stub_getter(className:String, propertyName:String):void;

    // Mark the setter where this function is invoked as stubbed.
    public native function stub_setter(className:String, propertyName:String):void;

    // Mark the constructor where this function is invoked as stubbed.
    public native function stub_constructor(className:String, specifics:String = null):void;

    // Note: the following function is not related to stubbing.

    // Produce a regular warning in Ruffle logs.
    public native function log_warn(...rest):void;

    // Filesystem support for AIR applications. The paths are URLs: the
    // application directory is an HTTP(S) URL, and the desktop is backed by
    // the browser's persistent storage (a virtual filesystem).
    public native function airApplicationDirectoryUrl():String;
    public native function airDesktopDirectoryUrl():String;
    public native function airFileExists(url:String):Boolean;
    public native function airFileSize(url:String):Number;
    public native function airReadFile(url:String):ByteArray;
    public native function airWriteFile(url:String, data:ByteArray):Boolean;
}
